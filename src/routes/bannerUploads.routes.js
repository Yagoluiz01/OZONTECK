import express from "express";
import { env } from "../config/env.js";
import { upload, MAX_BANNER_IMAGE_BYTES, MAX_BANNER_VIDEO_BYTES } from "../middlewares/bannerUpload.middleware.js";
import { requireAuth } from "./banners.routes.js";
import { verifyBucketExists } from "../services/storage.service.js";

const router = express.Router();

const BUCKET_NAME = "banner-images";

// Gerar UUID simples para cache busting
function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

// Processar imagem com Sharp (conversão para WEBP 80-85%)
async function processImage(buffer, deviceType, quality = 0.85) {
  try {
    const sharp = await import("sharp");
    
    const specs = deviceType === "mobile" 
      ? { width: 1080, height: 1920 } 
      : { width: 1920, height: 700 };

    const processed = await sharp
      .default(buffer)
      .resize(specs.width, specs.height, {
        fit: "cover",
        position: "center",
      })
      .toFormat("webp", { quality: Math.round(quality * 100) })
      .toBuffer();

    return {
      buffer: processed,
      mimeType: "image/webp",
    };
  } catch (error) {
    console.warn("Sharp error, using original:", error.message);
    return { buffer, mimeType: "image/jpeg" };
  }
}

// Upload para Supabase Storage
async function uploadToStorage(fileBuffer, fileName, mimeType, folder) {
  const uploadPath = `${folder}/${fileName}`;
  const uploadUrl = `${env.supabaseUrl}/storage/v1/object/banner-images/${uploadPath}`;

  const response = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      apikey: env.supabaseServiceRoleKey,
      Authorization: `Bearer ${env.supabaseServiceRoleKey}`,
      "Content-Type": mimeType,
      "Cache-Control": "public, max-age=31536000",
    },
    body: fileBuffer,
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error("STORAGE UPLOAD ERROR:", {
      status: response.status,
      body: errorText,
      url: uploadUrl,
    });
    throw new Error(`Upload falhou: ${errorText || response.statusText}`);
  }

  const publicUrl = `${env.supabaseUrl}/storage/v1/object/public/banner-images/${uploadPath}`;
  return { url: publicUrl, path: uploadPath };
}

// Validação de tamanho antes do upload
function validateFileSize(file, fieldName) {
  const isImage = fieldName.includes("image");
  const maxSize = isImage ? MAX_BANNER_IMAGE_BYTES : MAX_BANNER_VIDEO_BYTES;
  
  if (file.size > maxSize) {
    const sizeMB = maxSize / 1024 / 1024;
    throw new Error(`Arquivo muito grande. Máximo ${sizeMB}MB para ${fieldName}`);
  }
}

// Middleware para verificar bucket antes das rotas de upload
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

// Upload único para todos os 4 tipos de mídia
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

    const bannerId = req.query.banner_id || generateUUID();

    // Processar Desktop Image
    if (req.files?.desktop_image?.[0]) {
      const file = req.files.desktop_image[0];
      validateFileSize(file, "desktop_image");
      
      const processed = await processImage(file.buffer, "desktop", 0.85);
      const filename = `${bannerId}-desktop-${generateUUID()}.webp`;
      results.desktop_image = await uploadToStorage(processed.buffer, filename, processed.mimeType, "desktop");
    }

    // Processar Desktop Video
    if (req.files?.desktop_video?.[0]) {
      const file = req.files.desktop_video[0];
      validateFileSize(file, "desktop_video");
      
      const filename = `${bannerId}-desktop-${generateUUID()}.mp4`;
      results.desktop_video = await uploadToStorage(file.buffer, filename, "video/mp4", "videos");
    }

    // Processar Mobile Image
    if (req.files?.mobile_image?.[0]) {
      const file = req.files.mobile_image[0];
      validateFileSize(file, "mobile_image");
      
      const processed = await processImage(file.buffer, "mobile", 0.85);
      const filename = `${bannerId}-mobile-${generateUUID()}.webp`;
      results.mobile_image = await uploadToStorage(processed.buffer, filename, processed.mimeType, "mobile");
    }

    // Processar Mobile Video
    if (req.files?.mobile_video?.[0]) {
      const file = req.files.mobile_video[0];
      validateFileSize(file, "mobile_video");
      
      const filename = `${bannerId}-mobile-${generateUUID()}.mp4`;
      results.mobile_video = await uploadToStorage(file.buffer, filename, "video/mp4", "videos");
    }

    return res.status(200).json({
      success: true,
      message: "Arquivos enviados com sucesso",
      data: results,
    });
  } catch (error) {
    console.error("ERRO UPLOAD BANNER:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Erro ao enviar arquivos",
      code: "UPLOAD_ERROR",
    });
  }
});

// Upload individual (para substituir um único arquivo)
router.post("/upload/:type", requireAuth, checkBucketExists, upload.single("file"), async (req, res) => {
  try {
    const { type } = req.params;
    const allowedTypes = ["desktop_image", "desktop_video", "mobile_image", "mobile_video"];
    
    if (!allowedTypes.includes(type)) {
      return res.status(400).json({
        success: false,
        message: "Tipo inválido. Use: desktop_image, desktop_video, mobile_image, mobile_video",
      });
    }

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "Arquivo não enviado",
      });
    }

    validateFileSize(req.file, type);

    const bannerId = req.query.banner_id || generateUUID();
    let processed;
    
    if (type.includes("image")) {
      const deviceType = type === "mobile_image" ? "mobile" : "desktop";
      processed = await processImage(req.file.buffer, deviceType, 0.85);
    } else {
      processed = { buffer: req.file.buffer, mimeType: "video/mp4" };
    }

    const filename = `${bannerId}-${type}-${generateUUID()}.${processed.mimeType.includes("webp") ? "webp" : "mp4"}`;
    const folder = type.includes("video") ? "videos" : (type.includes("mobile") ? "mobile" : "desktop");
    
    const result = await uploadToStorage(processed.buffer, filename, processed.mimeType, folder);

    return res.status(200).json({
      success: true,
      data: { [type]: result },
    });
  } catch (error) {
    console.error("ERRO UPLOAD INDIVIDUAL:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Erro ao enviar arquivo",
    });
  }
});

// Deletar arquivo específico
router.delete("/upload/:type/:path", requireAuth, checkBucketExists, async (req, res) => {
  try {
    const { type, path: filePath } = req.params;
    
    // Sanitizar o path para evitar path traversal
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
      // Não falhar se o arquivo já foi removido ou não existe
    }

    return res.status(200).json({
      success: true,
      message: "Arquivo removido com sucesso",
    });
  } catch (error) {
    console.error("ERRO AO REMOVER ARQUIVO:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Erro ao remover arquivo",
    });
  }
});

export default router;