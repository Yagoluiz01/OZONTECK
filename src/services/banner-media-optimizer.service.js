import { spawn } from "child_process";
import os from "os";
import path from "path";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
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
const VIDEO_RENDER_TIMEOUT_MS = 180_000;
const MAX_OPTIMIZED_VIDEO_BYTES = 14.5 * 1024 * 1024;

const PRESETS = {
  high: {
    imageQuality: 82,
    videoTargetMb: 12,
    audioKbps: 112,
    videoPreset: "medium",
  },
  balanced: {
    imageQuality: 76,
    videoTargetMb: 8.5,
    audioKbps: 96,
    videoPreset: "medium",
  },
  compact: {
    imageQuality: 68,
    videoTargetMb: 5.8,
    audioKbps: 72,
    videoPreset: "fast",
  },
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizePreset(preset) {
  return Object.prototype.hasOwnProperty.call(PRESETS, preset) ? preset : "balanced";
}

function getDeviceSpec(mediaType) {
  const mobile = String(mediaType || "").startsWith("mobile");
  return mobile
    ? { width: 1080, height: 1920, mobile: true }
    : { width: 1920, height: 700, mobile: false };
}

function getSavingsPercent(originalSize, optimizedSize) {
  if (!originalSize || originalSize <= 0) return 0;
  return Math.max(0, Math.round((1 - optimizedSize / originalSize) * 100));
}

function runFfmpeg(args, timeoutMs = VIDEO_RENDER_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG_BINARY, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
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

    child.stdout.on("data", (chunk) => {
      if (stdout.length < 1_000_000) stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      if (stderr.length < 2_000_000) stderr += chunk.toString();
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
        finish(resolve, { stdout, stderr });
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
      if (stderr.length < 2_000_000) stderr += chunk.toString();
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
  if (preset === "high") return 0.92;
  if (preset === "compact") return 0.52;
  return 0.72;
}

function buildVideoBitrate(duration, targetMb, audioKbps, mobile) {
  const targetBits = targetMb * 1024 * 1024 * 8;
  const totalKbps = targetBits / Math.max(1, duration) / 1000;
  const maxVideoKbps = mobile ? 4200 : 5200;
  const videoKbps = Math.round(clamp(totalKbps - audioKbps, 220, maxVideoKbps));
  return videoKbps;
}

async function encodeVideo({ inputPath, outputPath, mediaType, preset, duration, hasAudio, originalSize, emergency = false }) {
  const spec = getDeviceSpec(mediaType);
  const selected = PRESETS[normalizePreset(preset)];
  const originalMb = Math.max(0.1, Number(originalSize || 0) / 1024 / 1024);
  const reductionRatio = selectedPresetRatio(preset);
  const normalTargetMb = Math.min(selected.videoTargetMb, originalMb * reductionRatio);
  const targetMb = emergency ? Math.min(5.2, originalMb * 0.45) : normalTargetMb;
  const audioKbps = emergency ? 64 : selected.audioKbps;
  const videoKbps = buildVideoBitrate(duration, targetMb, audioKbps, spec.mobile);
  const maxrateKbps = Math.max(videoKbps, Math.round(videoKbps * 1.08));
  const bufsizeKbps = Math.round(videoKbps * 2);

  const filter = [
    `scale=${spec.width}:${spec.height}:force_original_aspect_ratio=increase`,
    `crop=${spec.width}:${spec.height}`,
    "fps=30",
  ].join(",");

  const args = [
    "-hide_banner",
    "-loglevel", "error",
    "-i", inputPath,
    "-map", "0:v:0",
    "-vf", filter,
    "-c:v", "libx264",
    "-preset", emergency ? "fast" : selected.videoPreset,
    "-b:v", `${videoKbps}k`,
    "-maxrate", `${maxrateKbps}k`,
    "-bufsize", `${bufsizeKbps}k`,
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
  ];

  if (hasAudio) {
    args.push("-map", "0:a:0?", "-c:a", "aac", "-b:a", `${audioKbps}k`, "-ac", "2");
  } else {
    args.push("-an");
  }

  args.push("-y", outputPath);
  await runFfmpeg(args);
}

export async function optimizeBannerImage(buffer, mediaType, preset = "balanced") {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    throw new Error("Imagem inválida ou vazia");
  }
  if (buffer.length > MAX_MEDIA_OPTIMIZER_BYTES) {
    throw new Error("Imagem excede o limite máximo de 120MB para otimização");
  }

  const spec = getDeviceSpec(mediaType);
  const selectedPreset = normalizePreset(preset);
  const selected = PRESETS[selectedPreset];

  let quality = selected.imageQuality;
  let optimized = await sharp(buffer, { failOn: "none" })
    .rotate()
    .resize(spec.width, spec.height, {
      fit: "cover",
      position: "centre",
      withoutEnlargement: false,
    })
    .webp({ quality, effort: 5, smartSubsample: true })
    .toBuffer();

  // Imagens de banner não precisam ocupar vários MB. Se necessário, reduzimos
  // progressivamente a qualidade até atingir uma faixa adequada para a web.
  const targetBytes = selectedPreset === "high" ? 1.8 * 1024 * 1024 : selectedPreset === "compact" ? 850 * 1024 : 1.2 * 1024 * 1024;
  while (optimized.length > targetBytes && quality > 50) {
    quality -= 6;
    optimized = await sharp(buffer, { failOn: "none" })
      .rotate()
      .resize(spec.width, spec.height, {
        fit: "cover",
        position: "centre",
        withoutEnlargement: false,
      })
      .webp({ quality, effort: 6, smartSubsample: true })
      .toBuffer();
  }

  return {
    buffer: optimized,
    mimeType: "image/webp",
    extension: "webp",
    width: spec.width,
    height: spec.height,
    originalSize: buffer.length,
    optimizedSize: optimized.length,
    savingsPercent: getSavingsPercent(buffer.length, optimized.length),
    preset: selectedPreset,
  };
}

export async function optimizeBannerVideo(buffer, mediaType, preset = "balanced") {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    throw new Error("Vídeo inválido ou vazio");
  }
  if (buffer.length > MAX_MEDIA_OPTIMIZER_BYTES) {
    throw new Error("Vídeo excede o limite máximo de 120MB para otimização");
  }

  const selectedPreset = normalizePreset(preset);
  const spec = getDeviceSpec(mediaType);
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "ozonteck-banner-opt-"));
  const inputPath = path.join(tmpDir, "input.mp4");
  const outputPath = path.join(tmpDir, "output.mp4");

  try {
    await writeFile(inputPath, buffer);
    const metadata = await inspectVideo(inputPath);

    await encodeVideo({
      inputPath,
      outputPath,
      mediaType,
      preset: selectedPreset,
      duration: metadata.duration,
      hasAudio: metadata.hasAudio,
      originalSize: buffer.length,
    });

    let optimized = await readFile(outputPath);

    // Garantia adicional: mesmo vídeos difíceis de comprimir devem sair abaixo
    // do limite de upload do banner. Se ultrapassar, fazemos uma segunda passada
    // mais agressiva automaticamente.
    if (optimized.length > MAX_OPTIMIZED_VIDEO_BYTES) {
      await encodeVideo({
        inputPath,
        outputPath,
        mediaType,
        preset: "compact",
        duration: metadata.duration,
        hasAudio: metadata.hasAudio,
        originalSize: buffer.length,
        emergency: true,
      });
      optimized = await readFile(outputPath);
    }

    // Arquivos que já chegam muito leves não devem ficar maiores após uma
    // recodificação. Nesses casos mantemos o MP4 original, que já está abaixo
    // do limite e é mais econômico para a loja.
    if (buffer.length <= DIRECT_UPLOAD_LIMIT_BYTES && optimized.length >= buffer.length) {
      optimized = buffer;
    }

    if (!optimized.length) {
      throw new Error("FFmpeg gerou um vídeo vazio durante a otimização");
    }

    if (optimized.length > MAX_OPTIMIZED_VIDEO_BYTES) {
      throw new Error("Não foi possível reduzir o vídeo para menos de 15MB. Reduza a duração no Studio de Vídeo.");
    }

    return {
      buffer: optimized,
      mimeType: "video/mp4",
      extension: "mp4",
      width: spec.width,
      height: spec.height,
      duration: Number(metadata.duration.toFixed(3)),
      originalSize: buffer.length,
      optimizedSize: optimized.length,
      savingsPercent: getSavingsPercent(buffer.length, optimized.length),
      preset: selectedPreset,
    };
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function optimizeBannerMedia(buffer, mediaType, preset = "balanced") {
  if (String(mediaType).includes("image")) {
    return optimizeBannerImage(buffer, mediaType, preset);
  }
  if (String(mediaType).includes("video")) {
    return optimizeBannerVideo(buffer, mediaType, preset);
  }
  throw new Error("Tipo de mídia de banner inválido");
}
