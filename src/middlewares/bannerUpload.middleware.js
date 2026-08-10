import multer from "multer";

// Upload direto: até 15MB para qualquer mídia. Arquivos maiores são enviados
// pelo endpoint de otimização, que aceita até 120MB e comprime antes de salvar.
const MAX_BANNER_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_BANNER_VIDEO_BYTES = 15 * 1024 * 1024;
const MAX_BANNER_OPTIMIZER_BYTES = 120 * 1024 * 1024;

const ALLOWED_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

const ALLOWED_VIDEO_MIME_TYPES = new Set([
  "video/mp4",
]);

const IMAGE_SPECS = {
  desktop: { width: 1920, height: 700, aspectRatio: "16:7" },
  mobile: { width: 1080, height: 1920, aspectRatio: "9:16" },
};

const VIDEO_SPECS = {
  desktop: { width: 1920, height: 700, maxDuration: 30 },
  mobile: { width: 1080, height: 1920, maxDuration: 15 },
};

function validateBannerMime(file, callback, allowGenericField = false) {
  const mimeType = String(file.mimetype || "").toLowerCase();
  const fieldName = String(file.fieldname || "");

  const isImageField = fieldName === "desktop_image" || fieldName === "mobile_image";
  const isVideoField = fieldName === "desktop_video" || fieldName === "mobile_video";

  if (isImageField || (allowGenericField && ALLOWED_IMAGE_MIME_TYPES.has(mimeType))) {
    if (!ALLOWED_IMAGE_MIME_TYPES.has(mimeType)) {
      const error = new Error("Formato de imagem não permitido. Use JPG, PNG ou WEBP.");
      error.statusCode = 400;
      return callback(error);
    }
    return callback(null, true);
  }

  if (isVideoField || (allowGenericField && ALLOWED_VIDEO_MIME_TYPES.has(mimeType))) {
    if (!ALLOWED_VIDEO_MIME_TYPES.has(mimeType)) {
      const error = new Error("Formato de vídeo não permitido. Use MP4 (H.264)." );
      error.statusCode = 400;
      return callback(error);
    }
    return callback(null, true);
  }

  const error = new Error("Tipo de arquivo não permitido para banners.");
  error.statusCode = 400;
  return callback(error);
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_BANNER_VIDEO_BYTES,
    files: 4,
  },
  fileFilter(req, file, callback) {
    return validateBannerMime(file, callback, false);
  },
});

const mediaOptimizerUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_BANNER_OPTIMIZER_BYTES,
    files: 1,
  },
  fileFilter(req, file, callback) {
    return validateBannerMime(file, callback, true);
  },
});

export {
  upload,
  mediaOptimizerUpload,
  MAX_BANNER_IMAGE_BYTES,
  MAX_BANNER_VIDEO_BYTES,
  MAX_BANNER_OPTIMIZER_BYTES,
  ALLOWED_IMAGE_MIME_TYPES,
  ALLOWED_VIDEO_MIME_TYPES,
  IMAGE_SPECS,
  VIDEO_SPECS,
};
