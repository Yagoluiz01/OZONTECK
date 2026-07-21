import sharp from "sharp";
import { validateFile, sanitizeFileName } from "./storage.service.js";
import { env } from "../config/env.js";

const BUCKET_NAME = "banner-images";

let ffmpegAvailable = false;
try {
  const { execSync } = await import("child_process");
  try {
    execSync("ffmpeg -version", { stdio: ["ignore", "ignore", "ignore"] });
    ffmpegAvailable = true;
    console.log("[BANNER] FFmpeg detectado; optimização de vídeo ativada.");
  } catch {
    ffmpegAvailable = false;
    console.warn("[BANNER] FFmpeg não encontrado; vídeos serão salvos sem otimização.");
  }
} catch {
  ffmpegAvailable = false;
}

async function optimizeImage(buffer, width, height) {
  try {
    return await sharp(buffer)
      .rotate()
      .resize(width, height, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 85, effort: 4 })
      .toBuffer();
  } catch (error) {
    console.warn("Falha ao otimizar imagem do banner, usando original:", error);
    return buffer;
  }
}

async function tryOptimizeVideo(buffer, mimeType, deviceType) {
  // Tenta usar ffmpeg se estiver instalado no sistema
  try {
    const { spawn } = await import("child_process");
    const fs = await import("fs");
    const path = await import("path");
    const os = await import("os");

    const tmpInput = path.join(os.tmpdir(), `banner-input-${Date.now()}.mp4`);
    const tmpOutput = path.join(os.tmpdir(), `banner-output-${Date.now()}.mp4`);

    fs.writeFileSync(tmpInput, buffer);

    const specs =
      deviceType === "mobile"
        ? { width: 1080, height: 1920, maxDuration: 15 }
        : { width: 1920, height: 1080, maxDuration: 30 };

    return new Promise((resolve) => {
      const ffmpeg = spawn("ffmpeg", [
        "-i",
        tmpInput,
        "-vf",
        `scale=${specs.width}:${specs.height}:force_original_aspect_ratio=decrease`,
        "-c:v",
        "libx264",
        "-preset",
        "fast",
        "-crf",
        "28",
        "-movflags",
        "+faststart",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-ar",
        "44100",
        "-y",
        tmpOutput,
      ]);

      let stderr = "";
      ffmpeg.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      ffmpeg.on("close", async (code) => {
        try {
          if (code === 0 && fs.existsSync(tmpOutput)) {
            const optimized = fs.readFileSync(tmpOutput);
            resolve(optimized);
          } else {
            resolve(buffer);
          }
        } catch {
          resolve(buffer);
        } finally {
          try { fs.unlinkSync(tmpInput); } catch {}
          try { fs.unlinkSync(tmpOutput); } catch {}
        }
      });

      ffmpeg.on("error", () => {
        resolve(buffer);
      });

      // Timeout de 60s para não travar
      setTimeout(() => {
        ffmpeg.kill("SIGKILL");
        resolve(buffer);
      }, 60000);
    });
  } catch {
    return buffer;
  }
}

/**
 * Device-specific banner media upload
 * Formats image to target dimensions based on device type
 */
export async function uploadBannerMedia(file, deviceType = "desktop") {
  try {
    // Validate file
    const validation = validateFile(file, deviceType === "desktop" ? "image" : "image");
    if (!validation.valid) {
      return {
        success: false,
        message: validation.errors.join("; "),
      };
    }

    // Get dimensions based on device
    const dimensions = getDeviceDimensions(deviceType);

    // Optimize and process image
    const processedBuffer = await optimizeImage(
      file.buffer,
      dimensions.width,
      dimensions.height
    );

    // Generate filename with device prefix
    const originalName = file.originalname || file.name || "banner";
    const sanitizedName = sanitizeFileName(originalName);
    const filename = `${deviceType}-${Date.now()}-${sanitizedName}.webp`;

    // Upload to Supabase Storage
    const uploadPath = `banners/${filename}`;
    const response = await fetch(
      `${env.supabaseUrl}/storage/v1/object/${BUCKET_NAME}/${uploadPath}`,
      {
        method: "POST",
        headers: {
          apikey: env.supabaseServiceRoleKey,
          Authorization: `Bearer ${env.supabaseServiceRoleKey}`,
          "Content-Type": "image/webp",
          "Cache-Control": "public, max-age=31536000",
        },
        body: processedBuffer,
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      return {
        success: false,
        message: `Upload failed: ${errorText}`,
      };
    }

    const publicUrl = `${env.supabaseUrl}/storage/v1/object/public/${BUCKET_NAME}/${uploadPath}`;

    return {
      success: true,
      url: publicUrl,
      path: uploadPath,
      filename,
      deviceType,
      dimensions,
    };
  } catch (error) {
    console.error("Banner media upload error:", error);
    return {
      success: false,
      message: `Upload error: ${error.message}`,
    };
  }
}

/**
 * Get target dimensions based on device type
 */
function getDeviceDimensions(deviceType) {
  const specs = {
    mobile: {
      width: 1080,
      height: 1920,
      aspectRatio: "9:16",
    },
    desktop: {
      width: 1920,
      height: 1080,
      aspectRatio: "16:9",
    },
    tablet: {
      width: 1200,
      height: 1600,
      aspectRatio: "3:4",
    },
  };

  return specs[deviceType] || specs.desktop;
}

/**
 * Upload video file (validates duration)
 */
export async function uploadBannerVideo(file, deviceType = "desktop") {
  try {
    // Validate video file
    const validation = validateFile(file, "video");
    if (!validation.valid) {
      return {
        success: false,
        message: validation.errors.join("; "),
      };
    }

    // Generate filename
    const originalName = file.originalname || file.name || "banner-video";
    const sanitizedName = sanitizeFileName(originalName);
    const filename = `${deviceType}-video-${Date.now()}-${sanitizedName}.mp4`;

    // Tentar otimizar vídeo se ffmpeg estiver disponível
    const optimizedBuffer = await tryOptimizeVideo(file.buffer, file.mimetype, deviceType);

    // Upload to Supabase Storage
    const uploadPath = `banners/videos/${filename}`;
    const response = await fetch(
      `${env.supabaseUrl}/storage/v1/object/${BUCKET_NAME}/${uploadPath}`,
      {
        method: "POST",
        headers: {
          apikey: env.supabaseServiceRoleKey,
          Authorization: `Bearer ${env.supabaseServiceRoleKey}`,
          "Content-Type": "video/mp4",
        },
        body: optimizedBuffer,
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      return {
        success: false,
        message: `Upload failed: ${errorText}`,
      };
    }

    const publicUrl = `${env.supabaseUrl}/storage/v1/object/public/${BUCKET_NAME}/${uploadPath}`;

    return {
      success: true,
      url: publicUrl,
      path: uploadPath,
      filename,
      deviceType,
      type: "video",
    };
  } catch (error) {
    console.error("Banner video upload error:", error);
    return {
      success: false,
      message: `Upload error: ${error.message}`,
    };
  }
}