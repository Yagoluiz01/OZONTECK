import { spawn } from "child_process";
import os from "os";
import path from "path";
import { mkdtemp, rm, stat } from "fs/promises";
import sharp from "sharp";

let bundledFfmpegPath = null;
try {
  const ffmpegStaticModule = await import("ffmpeg-static");
  bundledFfmpegPath = ffmpegStaticModule.default || ffmpegStaticModule;
} catch {
  bundledFfmpegPath = null;
}

const FFMPEG_BINARY = String(
  process.env.FFMPEG_BIN ||
  process.env.FFMPEG_PATH ||
  bundledFfmpegPath ||
  "ffmpeg"
).trim();

export const MAX_MEDIA_OPTIMIZER_BYTES = 120 * 1024 * 1024;
export const DIRECT_UPLOAD_LIMIT_BYTES = 15 * 1024 * 1024;
const VIDEO_RENDER_TIMEOUT_MS = 300_000;
const MAX_OPTIMIZED_VIDEO_BYTES = 14.5 * 1024 * 1024;

const PRESETS = {
  high: {
    imageQuality: 82,
    videoTargetMb: 11.5,
    audioKbps: 96,
    videoPreset: "veryfast",
  },
  balanced: {
    imageQuality: 76,
    videoTargetMb: 7.5,
    audioKbps: 80,
    videoPreset: "superfast",
  },
  compact: {
    imageQuality: 68,
    videoTargetMb: 4.8,
    audioKbps: 64,
    videoPreset: "ultrafast",
  },
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizePreset(preset) {
  return Object.prototype.hasOwnProperty.call(PRESETS, preset) ? preset : "balanced";
}

function getDeviceSpec(mediaType, preset = "balanced") {
  const mobile = String(mediaType || "").startsWith("mobile");

  if (preset === "high") {
    return mobile
      ? { width: 1080, height: 1920, mobile: true, fps: 30 }
      : { width: 1920, height: 700, mobile: false, fps: 30 };
  }

  if (preset === "compact") {
    return mobile
      ? { width: 540, height: 960, mobile: true, fps: 24 }
      : { width: 960, height: 350, mobile: false, fps: 24 };
  }

  return mobile
    ? { width: 720, height: 1280, mobile: true, fps: 24 }
    : { width: 1280, height: 466, mobile: false, fps: 24 };
}

function getSavingsPercent(originalSize, optimizedSize) {
  if (!originalSize || originalSize <= 0) return 0;
  return Math.max(0, Math.round((1 - optimizedSize / originalSize) * 100));
}

function runFfmpeg(args, timeoutMs = VIDEO_RENDER_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG_BINARY, [
      "-threads", "1",
      "-filter_threads", "1",
      "-filter_complex_threads", "1",
      ...args,
    ], {
      stdio: ["ignore", "ignore", "pipe"],
    });

    let stderr = "";
    let settled = false;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(reject, new Error("FFmpeg excedeu o tempo máximo ao otimizar o vídeo"));
    }, timeoutMs);

    child.stderr.on("data", (chunk) => {
      if (stderr.length < 512_000) stderr += chunk.toString();
    });

    child.on("error", (error) => {
      if (error.code === "ENOENT") {
        finish(reject, new Error("FFmpeg indisponível. Execute npm install na raiz da API."));
      } else {
        finish(reject, error);
      }
    });

    child.on("close", (code) => {
      if (code === 0) {
        finish(resolve, { stderr });
      } else {
        const detail = stderr.trim().split("\n").slice(-8).join(" | ");
        finish(reject, new Error(`FFmpeg falhou (${code})${detail ? `: ${detail}` : ""}`));
      }
    });
  });
}

function parseDuration(stderr = "") {
  const match = stderr.match(/Duration:\s*(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/i);
  if (!match) return 0;

  const duration = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  return Number.isFinite(duration) ? duration : 0;
}

function inspectVideo(filePath) {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG_BINARY, [
      "-hide_banner",
      "-nostdin",
      "-threads", "1",
      "-i", filePath,
    ], {
      stdio: ["ignore", "ignore", "pipe"],
    });

    let stderr = "";
    let settled = false;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(reject, new Error("FFmpeg excedeu o tempo máximo ao analisar o vídeo"));
    }, 20_000);

    child.stderr.on("data", (chunk) => {
      if (stderr.length < 512_000) stderr += chunk.toString();
    });

    child.on("error", (error) => {
      if (error.code === "ENOENT") {
        finish(reject, new Error("FFmpeg indisponível. Execute npm install na raiz da API."));
      } else {
        finish(reject, error);
      }
    });

    child.on("close", () => {
      const duration = parseDuration(stderr);
      const hasVideo = /Stream[^\n]*Video:/i.test(stderr);
      const hasAudio = /Stream[^\n]*Audio:/i.test(stderr);

      if (!hasVideo) {
        finish(reject, new Error("O arquivo não possui uma faixa de vídeo válida"));
        return;
      }

      if (!duration || duration <= 0) {
        finish(reject, new Error("Não foi possível identificar a duração do vídeo"));
        return;
      }

      finish(resolve, { duration, hasAudio });
    });
  });
}

function selectedPresetRatio(preset) {
  if (preset === "high") return 0.90;
  if (preset === "compact") return 0.48;
  return 0.68;
}

function buildVideoBitrate(duration, targetMb, audioKbps, mobile) {
  const targetBits = targetMb * 1024 * 1024 * 8 * 0.94;
  const totalKbps = targetBits / Math.max(1, duration) / 1000;
  const maxVideoKbps = mobile ? 3200 : 3800;
  return Math.round(clamp(totalKbps - audioKbps, 220, maxVideoKbps));
}

async function encodeVideo({ inputPath, outputPath, mediaType, preset, duration, hasAudio, originalSize, emergency = false }) {
  const selectedPreset = normalizePreset(preset);
  const spec = getDeviceSpec(mediaType, selectedPreset);
  const selected = PRESETS[selectedPreset];
  const originalMb = Math.max(0.1, Number(originalSize || 0) / 1024 / 1024);
  const reductionRatio = selectedPresetRatio(selectedPreset);
  const normalTargetMb = Math.min(selected.videoTargetMb, originalMb * reductionRatio);
  const targetMb = emergency ? Math.min(4.2, originalMb * 0.40) : normalTargetMb;
  const audioKbps = emergency ? 56 : selected.audioKbps;
  const videoKbps = buildVideoBitrate(duration, targetMb, audioKbps, spec.mobile);
  const maxrateKbps = Math.max(videoKbps, Math.round(videoKbps * 1.06));
  const bufsizeKbps = Math.max(512, Math.round(videoKbps * 1.5));

  const filter = [
    `scale=${spec.width}:${spec.height}:force_original_aspect_ratio=increase`,
    `crop=${spec.width}:${spec.height}`,
    `fps=${spec.fps}`,
    "format=yuv420p",
  ].join(",");

  const args = [
    "-hide_banner",
    "-loglevel", "error",
    "-nostdin",
    "-i", inputPath,
    "-map", "0:v:0",
    "-vf", filter,
    "-c:v", "libx264",
    "-preset", emergency ? "ultrafast" : selected.videoPreset,
    "-b:v", `${videoKbps}k`,
    "-maxrate", `${maxrateKbps}k`,
    "-bufsize", `${bufsizeKbps}k`,
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
  ];

  if (hasAudio) {
    args.push("-map", "0:a:0?", "-c:a", "aac", "-b:a", `${audioKbps}k`, "-ac", "1");
  } else {
    args.push("-an");
  }

  args.push("-y", outputPath);
  await runFfmpeg(args);

  return spec;
}

export async function optimizeBannerImageFile(inputPath, originalSize, mediaType, preset = "balanced") {
  if (!inputPath) throw new Error("Imagem inválida ou vazia");
  if (originalSize > MAX_MEDIA_OPTIMIZER_BYTES) {
    throw new Error("Imagem excede o limite máximo de 120MB para otimização");
  }

  const selectedPreset = normalizePreset(preset);
  const spec = getDeviceSpec(mediaType, selectedPreset);
  const selected = PRESETS[selectedPreset];
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "ozonteck-banner-img-opt-"));
  const outputPath = path.join(tmpDir, "output.webp");
  let quality = selected.imageQuality;

  try {
    await sharp(inputPath, { failOn: "none", sequentialRead: true })
      .rotate()
      .resize(spec.width, spec.height, {
        fit: "cover",
        position: "centre",
        withoutEnlargement: false,
      })
      .webp({ quality, effort: 4, smartSubsample: true })
      .toFile(outputPath);

    const targetBytes = selectedPreset === "high"
      ? 1.6 * 1024 * 1024
      : selectedPreset === "compact"
        ? 700 * 1024
        : 1.0 * 1024 * 1024;

    let info = await stat(outputPath);
    while (info.size > targetBytes && quality > 52) {
      quality -= 7;
      await sharp(inputPath, { failOn: "none", sequentialRead: true })
        .rotate()
        .resize(spec.width, spec.height, {
          fit: "cover",
          position: "centre",
          withoutEnlargement: false,
        })
        .webp({ quality, effort: 4, smartSubsample: true })
        .toFile(outputPath);
      info = await stat(outputPath);
    }

    return {
      outputPath,
      cleanupDir: tmpDir,
      mimeType: "image/webp",
      extension: "webp",
      width: spec.width,
      height: spec.height,
      originalSize,
      optimizedSize: info.size,
      savingsPercent: getSavingsPercent(originalSize, info.size),
      preset: selectedPreset,
    };
  } catch (error) {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function optimizeBannerVideoFile(inputPath, originalSize, mediaType, preset = "balanced") {
  if (!inputPath) throw new Error("Vídeo inválido ou vazio");
  if (originalSize > MAX_MEDIA_OPTIMIZER_BYTES) {
    throw new Error("Vídeo excede o limite máximo de 120MB para otimização");
  }

  const selectedPreset = normalizePreset(preset);
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "ozonteck-banner-video-opt-"));
  const outputPath = path.join(tmpDir, "output.mp4");

  try {
    const metadata = await inspectVideo(inputPath);

    const spec = await encodeVideo({
      inputPath,
      outputPath,
      mediaType,
      preset: selectedPreset,
      duration: metadata.duration,
      hasAudio: metadata.hasAudio,
      originalSize,
    });

    let info = await stat(outputPath);

    if (info.size > MAX_OPTIMIZED_VIDEO_BYTES) {
      await encodeVideo({
        inputPath,
        outputPath,
        mediaType,
        preset: "compact",
        duration: metadata.duration,
        hasAudio: metadata.hasAudio,
        originalSize,
        emergency: true,
      });
      info = await stat(outputPath);
    }

    if (!info.size) {
      throw new Error("FFmpeg gerou um vídeo vazio durante a otimização");
    }

    if (info.size > MAX_OPTIMIZED_VIDEO_BYTES) {
      throw new Error("Não foi possível reduzir o vídeo para menos de 15MB. Reduza a duração no Studio de Vídeo.");
    }

    return {
      outputPath,
      cleanupDir: tmpDir,
      mimeType: "video/mp4",
      extension: "mp4",
      width: spec.width,
      height: spec.height,
      duration: Number(metadata.duration.toFixed(3)),
      originalSize,
      optimizedSize: info.size,
      savingsPercent: getSavingsPercent(originalSize, info.size),
      preset: selectedPreset,
    };
  } catch (error) {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function optimizeBannerMediaFile(inputPath, originalSize, mediaType, preset = "balanced") {
  if (String(mediaType).includes("image")) {
    return optimizeBannerImageFile(inputPath, originalSize, mediaType, preset);
  }
  if (String(mediaType).includes("video")) {
    return optimizeBannerVideoFile(inputPath, originalSize, mediaType, preset);
  }
  throw new Error("Tipo de mídia de banner inválido");
}
