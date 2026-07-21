import multer from "multer";
import { env } from "../config/env.js";

// Limites de tamanho conforme especificado
const MAX_BANNER_IMAGE_BYTES = 3 * 1024 * 1024; // 3MB
const MAX_BANNER_VIDEO_BYTES = 15 * 1024 * 1024; // 15MB

// Tipos permitidos conforme requisitos
const ALLOWED_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

const ALLOWED_VIDEO_MIME_TYPES = new Set([
  "video/mp4",
]);

// Resoluções recomendadas
const IMAGE_SPECS = {
  desktop: { width: 1920, height: 700, aspectRatio: "16:7" },
  mobile: { width: 1080, height: 1920, aspectRatio: "9:16" },
};

const VIDEO_SPECS = {
  desktop: { width: 1920, height: 700, maxDuration: 30 },
  mobile: { width: 1080, height: 1920, maxDuration: 15 },
};

// Configuração do multer para múltiplos arquivos
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_BANNER_VIDEO_BYTES,
    files: 4, // desktop_image, desktop_video, mobile_image, mobile_video
  },
  fileFilter(req, file, callback) {
    const mimeType = String(file.mimetype || "").toLowerCase();
    const fieldName = file.fieldname; // desktop_image, desktop_video, mobile_image, mobile_video

    // Verificar se é imagem
    if (fieldName === "desktop_image" || fieldName === "mobile_image") {
      if (!ALLOWED_IMAGE_MIME_TYPES.has(mimeType)) {
        const error = new Error(
          "Formato de imagem não permitido. Use JPG, PNG ou WEBP."
        );
        error.statusCode = 400;
        return callback(error);
      }
    }

    // Verificar se é vídeo (apenas MP4 H264)
    if (fieldName === "desktop_video" || fieldName === "mobile_video") {
      if (!ALLOWED_VIDEO_MIME_TYPES.has(mimeType)) {
        const error = new Error(
          "Formato de vídeo não permitido. Use MP4 (H.264)."
        );
        error.statusCode = 400;
        return callback(error);
      }
    }

    return callback(null, true);
  },
});

export {
  upload,
  MAX_BANNER_IMAGE_BYTES,
  MAX_BANNER_VIDEO_BYTES,
  ALLOWED_IMAGE_MIME_TYPES,
  ALLOWED_VIDEO_MIME_TYPES,
  IMAGE_SPECS,
  VIDEO_SPECS,
};