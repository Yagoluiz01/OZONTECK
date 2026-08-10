import express from "express";
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
import { optimizeBannerMedia } from "../services/banner-media-optimizer.service.js";

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

async function uploadToStorage(fileBuffer, fileName, mimeType, folder) {
  const uploadPath = `${folder}/${fileName}`;
  const { error } = await supabaseAdmin.storage.from(BUCKET_NAME).upload(uploadPath, fileBuffer, {
    contentType: mimeType,
    cacheControl: "31536000",
    upsert: false,
  });

  if (error) {
    console.error("STORAGE UPLOAD ERROR:", { message: error.message, path: uploadPath });
    throw new Error(`Upload falhou: ${error.message}`);
  }

  const { data } = supabaseAdmin.storage.from(BUCKET_NAME).getPublicUrl(uploadPath);
  return { url: data.publicUrl, path: uploadPath };
}

async function optimizeAndStore(file, type, bannerId, preset = "balanced") {
  const optimized = await optimizeBannerMedia(file.buffer, type, preset);
  const filename = `${bannerId}-${type}-${generateUUID()}.${optimized.extension}`;
  const stored = await uploadToStorage(
    optimized.buffer,
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

// Upload padrão. Toda mídia é otimizada antes de chegar ao Storage.
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
    console.error("ERRO UPLOAD BANNER:", error);
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || "Erro ao enviar arquivos",
      code: error.statusCode === 413 ? "MEDIA_REQUIRES_OPTIMIZATION" : "UPLOAD_ERROR",
    });
  }
});

// Upload individual. Também otimiza automaticamente antes de salvar.
router.post("/upload/:type", requireAuth, checkBucketExists, upload.single("file"), async (req, res) => {
  try {
    const { type } = req.params;
    if (!ALLOWED_MEDIA_TYPES.includes(type)) {
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
    console.error("ERRO UPLOAD INDIVIDUAL:", error);
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || "Erro ao enviar arquivo",
      code: error.statusCode === 413 ? "MEDIA_REQUIRES_OPTIMIZATION" : "UPLOAD_ERROR",
    });
  }
});

// Arquivos acima de 15MB entram neste fluxo. O endpoint aceita até 120MB,
// comprime e só então envia o resultado leve ao Storage.
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
      console.error("ERRO OTIMIZADOR DE MÍDIA:", error);
      return res.status(error.statusCode || 500).json({
        success: false,
        message: error.message || "Erro ao otimizar mídia",
        code: "MEDIA_OPTIMIZATION_ERROR",
      });
    }
  }
);

// Legendas automáticas do Studio. O recurso é opcional e só é ativado quando
// OPENAI_API_KEY estiver configurada no ambiente da API.
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

// Editor profissional de vídeo: renderiza cortes, ajustes, áudio e transformações com FFmpeg.
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
