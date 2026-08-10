import express from "express";
import { createReadStream } from "fs";
import { rm } from "fs/promises";
import { env } from "../config/env.js";
import {
  upload,
  mediaOptimizerUpload,
  MAX_BANNER_IMAGE_BYTES,
  MAX_BANNER_VIDEO_BYTES,
} from "../middlewares/bannerUpload.middleware.js";
import { requireAuth } from "./banners.routes.js";
import { verifyBucketExists } from "../services/storage.service.js";
import { supabaseAdmin } from "../config/supabase.js";
import { renderBannerVideo, transcribeBannerVideo } from "../services/banner-video-editor.service.js";
import { optimizeBannerMediaFile } from "../services/banner-media-optimizer.service.js";

const router = express.Router();
const BUCKET_NAME = "banner-images";
const ALLOWED_MEDIA_TYPES = ["desktop_image", "desktop_video", "mobile_image", "mobile_video"];

function generateUUID() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === "x" ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

function getFolder(type) {
  if (type.includes("video")) return "videos";
  return type.includes("mobile") ? "mobile" : "desktop";
}

function getDirectLimit(type) {
  return type.includes("image") ? MAX_BANNER_IMAGE_BYTES : MAX_BANNER_VIDEO_BYTES;
}

function validateDirectFileSize(file, type) {
  const maxSize = getDirectLimit(type);
  if (file.size > maxSize) {
    const error = new Error(`Arquivo acima de ${Math.round(maxSize / 1024 / 1024)}MB. Use o otimizador automático.`);
    error.statusCode = 413;
    throw error;
  }
}

async function removeTempFile(filePath) {
  if (!filePath) return;
  await rm(filePath, { force: true }).catch(() => {});
}

async function uploadFileToStorage(filePath, fileName, mimeType, folder) {
  const uploadPath = `${folder}/${fileName}`;
  const uploadUrl = `${env.supabaseUrl}/storage/v1/object/${BUCKET_NAME}/${uploadPath
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;

  const response = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      apikey: env.supabaseServiceRoleKey,
      Authorization: `Bearer ${env.supabaseServiceRoleKey}`,
      "Content-Type": mimeType,
      "Cache-Control": "max-age=31536000",
      "x-upsert": "false",
    },
    body: createReadStream(filePath),
    duplex: "half",
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    console.error("STORAGE STREAM UPLOAD ERROR:", {
      status: response.status,
      body: detail,
      path: uploadPath,
    });
    throw new Error(`Upload falhou (${response.status})${detail ? `: ${detail}` : ""}`);
  }

  const { data } = supabaseAdmin.storage.from(BUCKET_NAME).getPublicUrl(uploadPath);
  return { url: data.publicUrl, path: uploadPath };
}

async function optimizeAndStore(file, type, bannerId, preset = "balanced") {
  let optimized = null;

  try {
    optimized = await optimizeBannerMediaFile(file.path, file.size, type, preset);
    const filename = `${bannerId}-${type}-${generateUUID()}.${optimized.extension}`;

    const stored = await uploadFileToStorage(
      optimized.outputPath,
      filename,
      optimized.mimeType,
      getFolder(type)
    );

    return {
      ...stored,
      originalName: file.originalname || filename,
      originalSize: optimized.originalSize,
      optimizedSize: optimized.optimizedSize,
      savingsPercent: optimized.savingsPercent,
      width: optimized.width,
      height: optimized.height,
      duration: optimized.duration || null,
      preset: optimized.preset,
      optimized: true,
    };
  } finally {
    if (optimized?.cleanupDir) {
      await rm(optimized.cleanupDir, { recursive: true, force: true }).catch(() => {});
    }
    await removeTempFile(file?.path);
  }
}

async function checkBucketExists(req, res, next) {
  try {
    const bucketCheck = await verifyBucketExists();
    if (!bucketCheck.exists) {
      return res.status(500).json({
        success: false,
        message: bucketCheck.message || "Bucket de armazenamento de banners não encontrado",
        code: bucketCheck.code || "BUCKET_ERROR",
        details: bucketCheck.details || null,
      });
    }
    req.bucketReady = true;
    next();
  } catch (error) {
    console.error("BUCKET CHECK ERROR:", error);
    return res.status(503).json({
      success: false,
      message: "Serviço de armazenamento temporariamente indisponível",
      code: "STORAGE_UNAVAILABLE",
    });
  }
}

async function cleanupRequestFiles(req) {
  const files = [];
  if (req.file?.path) files.push(req.file.path);

  for (const list of Object.values(req.files || {})) {
    if (!Array.isArray(list)) continue;
    for (const file of list) {
      if (file?.path) files.push(file.path);
    }
  }

  await Promise.all(files.map(removeTempFile));
}

router.post("/upload", requireAuth, checkBucketExists, upload.fields([
  { name: "desktop_image", maxCount: 1 },
  { name: "desktop_video", maxCount: 1 },
  { name: "mobile_image", maxCount: 1 },
  { name: "mobile_video", maxCount: 1 },
]), async (req, res) => {
  try {
    const results = {
      desktop_image: null,
      desktop_video: null,
      mobile_image: null,
      mobile_video: null,
    };

    const bannerId = req.body?.banner_id || req.query.banner_id || generateUUID();

    for (const type of ALLOWED_MEDIA_TYPES) {
      const file = req.files?.[type]?.[0];
      if (!file) continue;
      validateDirectFileSize(file, type);
      results[type] = await optimizeAndStore(file, type, bannerId, "balanced");
    }

    return res.status(200).json({
      success: true,
      message: "Mídia otimizada e enviada com sucesso",
      data: results,
    });
  } catch (error) {
    await cleanupRequestFiles(req);
    console.error("ERRO UPLOAD BANNER:", error);
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || "Erro ao enviar arquivos",
      code: error.statusCode === 413 ? "MEDIA_REQUIRES_OPTIMIZATION" : "UPLOAD_ERROR",
    });
  }
});

router.post("/upload/:type", requireAuth, checkBucketExists, upload.single("file"), async (req, res) => {
  try {
    const { type } = req.params;
    if (!ALLOWED_MEDIA_TYPES.includes(type)) {
      await removeTempFile(req.file?.path);
      return res.status(400).json({
        success: false,
        message: "Tipo inválido. Use desktop_image, desktop_video, mobile_image ou mobile_video",
      });
    }

    if (!req.file) {
      return res.status(400).json({ success: false, message: "Arquivo não enviado" });
    }

    validateDirectFileSize(req.file, type);
    const bannerId = req.body?.banner_id || req.query.banner_id || generateUUID();
    const result = await optimizeAndStore(req.file, type, bannerId, "balanced");

    return res.status(200).json({
      success: true,
      message: "Mídia otimizada e enviada com sucesso",
      data: { [type]: result },
    });
  } catch (error) {
    await removeTempFile(req.file?.path);
    console.error("ERRO UPLOAD INDIVIDUAL:", error);
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || "Erro ao enviar arquivo",
      code: error.statusCode === 413 ? "MEDIA_REQUIRES_OPTIMIZATION" : "UPLOAD_ERROR",
    });
  }
});

router.post(
  "/media-optimizer/:type",
  requireAuth,
  checkBucketExists,
  mediaOptimizerUpload.single("file"),
  async (req, res) => {
    try {
      const { type } = req.params;
      const preset = ["high", "balanced", "compact"].includes(req.body?.preset)
        ? req.body.preset
        : "compact";

      if (!ALLOWED_MEDIA_TYPES.includes(type)) {
        await removeTempFile(req.file?.path);
        return res.status(400).json({ success: false, message: "Tipo de mídia inválido" });
      }

      if (!req.file) {
        return res.status(400).json({ success: false, message: "Arquivo não enviado" });
      }

      const bannerId = req.body?.banner_id || req.query.banner_id || generateUUID();
      const result = await optimizeAndStore(req.file, type, bannerId, preset);

      return res.status(200).json({
        success: true,
        message: "Arquivo comprimido, otimizado e vinculado ao banner",
        data: { [type]: result },
      });
    } catch (error) {
      await removeTempFile(req.file?.path);
      console.error("ERRO OTIMIZADOR DE MÍDIA:", error);
      return res.status(error.statusCode || 500).json({
        success: false,
        message: error.message || "Erro ao otimizar mídia",
        code: "MEDIA_OPTIMIZATION_ERROR",
      });
    }
  }
);

router.post("/video-editor/captions", requireAuth, async (req, res) => {
  try {
    const { source_url, language = "auto" } = req.body || {};

    if (!source_url || typeof source_url !== "string") {
      return res.status(400).json({ success: false, message: "source_url é obrigatório" });
    }

    const result = await transcribeBannerVideo({
      sourceUrl: source_url,
      language,
    });

    return res.status(200).json({
      success: true,
      message: "Legendas geradas com sucesso",
      data: result,
    });
  } catch (error) {
    console.error("ERRO LEGENDAS AUTOMÁTICAS DO BANNER:", error);
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || "Erro ao gerar legendas automáticas",
      code: error.code || "CAPTIONS_GENERATION_ERROR",
    });
  }
});

router.post("/video-editor/render", requireAuth, checkBucketExists, async (req, res) => {
  try {
    const { source_url, media_type = "desktop_video", settings = {} } = req.body || {};

    if (!source_url || typeof source_url !== "string") {
      return res.status(400).json({ success: false, message: "source_url é obrigatório" });
    }

    if (!["desktop_video", "mobile_video"].includes(media_type)) {
      return res.status(400).json({
        success: false,
        message: "media_type inválido. Use desktop_video ou mobile_video",
      });
    }

    const result = await renderBannerVideo({
      sourceUrl: source_url,
      mediaType: media_type,
      rawSettings: settings,
    });

    return res.status(200).json({
      success: true,
      message: "Vídeo renderizado com sucesso",
      data: result,
    });
  } catch (error) {
    console.error("ERRO EDITOR DE VÍDEO DO BANNER:", error);
    const message = error.message || "Erro ao renderizar vídeo";
    const missingFfmpeg = /ffmpeg/i.test(message) && /não está instalado|indisponível|ENOENT/i.test(message);

    return res.status(missingFfmpeg ? 503 : 500).json({
      success: false,
      message,
      code: missingFfmpeg ? "FFMPEG_UNAVAILABLE" : "VIDEO_RENDER_ERROR",
    });
  }
});

router.delete("/upload/:type/:path", requireAuth, checkBucketExists, async (req, res) => {
  try {
    const { type, path: filePath } = req.params;
    const sanitizedPath = decodeURIComponent(filePath).replace(/\.\./g, "").replace(/^\/+/, "");
    const deleteUrl = `${env.supabaseUrl}/storage/v1/object/banner-images/${type}/${encodeURIComponent(sanitizedPath)}`;

    const deleteResponse = await fetch(deleteUrl, {
      method: "DELETE",
      headers: {
        apikey: env.supabaseServiceRoleKey,
        Authorization: `Bearer ${env.supabaseServiceRoleKey}`,
      },
    });

    if (!deleteResponse.ok) {
      const errorText = await deleteResponse.text();
      console.error("STORAGE DELETE ERROR:", {
        status: deleteResponse.status,
        body: errorText,
        url: deleteUrl,
      });
    }

    return res.status(200).json({ success: true, message: "Arquivo removido com sucesso" });
  } catch (error) {
    console.error("ERRO AO REMOVER ARQUIVO:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Erro ao remover arquivo",
    });
  }
});

export default router;
