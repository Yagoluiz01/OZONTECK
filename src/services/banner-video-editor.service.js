import { spawn } from "child_process";
import crypto from "crypto";
import os from "os";
import path from "path";
import { createReadStream } from "fs";
import { mkdtemp, rm, writeFile, readFile } from "fs/promises";
import sharp from "sharp";
import OpenAI from "openai";
import { env } from "../config/env.js";
import { supabaseAdmin } from "../config/supabase.js";

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

const BUCKET_NAME = "banner-images";
const MAX_SOURCE_BYTES = 120 * 1024 * 1024;
const RENDER_TIMEOUT_MS = 720_000;
const MAX_FINAL_VIDEO_BYTES = 14.5 * 1024 * 1024;
const MAX_SEGMENTS = 12;
const MAX_CAPTIONS = 80;

const ALLOWED_TRANSITIONS = new Set([
  "none",
  "fade",
  "dissolve",
  "fadeblack",
  "fadewhite",
  "wipeleft",
  "wiperight",
  "wipeup",
  "wipedown",
  "slideleft",
  "slideright",
  "slideup",
  "slidedown",
  "circleopen",
  "circleclose",
  "pixelize",
]);

const ALLOWED_EFFECTS = new Set([
  "original",
  "cinematic",
  "vivid",
  "warm",
  "cool",
  "noir",
  "vintage",
  "dream",
  "sharp",
  "grain",
  "vignette",
  "soft",
]);

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function asNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeRotation(value) {
  const normalized = ((Math.round(asNumber(value, 0)) % 360) + 360) % 360;
  return [0, 90, 180, 270].includes(normalized) ? normalized : 0;
}

function validateSourceUrl(sourceUrl) {
  let parsed;
  let supabase;

  try {
    parsed = new URL(sourceUrl);
    supabase = new URL(env.supabaseUrl);
  } catch {
    throw new Error("URL de origem inválida");
  }

  if (parsed.origin !== supabase.origin) {
    throw new Error("A origem do vídeo não é permitida");
  }

  const expectedPrefix = `/storage/v1/object/public/${BUCKET_NAME}/`;
  if (!parsed.pathname.startsWith(expectedPrefix)) {
    throw new Error("O vídeo deve estar no bucket público de banners");
  }

  return parsed.toString();
}

function runProcess(command, args, timeoutMs = RENDER_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
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
      finish(reject, new Error(`${path.basename(command)} excedeu o tempo máximo de processamento`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      if (stdout.length < 2_000_000) stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      if (stderr.length < 4_000_000) stderr += chunk.toString();
    });

    child.on("error", (error) => {
      if (error.code === "ENOENT") {
        finish(reject, new Error("FFmpeg indisponível. Execute npm install na raiz da API para instalar o binário empacotado."));
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

function parseFfmpegDuration(stderr = "") {
  const durationMatch = stderr.match(/Duration:\s*(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/i);
  if (durationMatch) {
    const hours = Number(durationMatch[1]);
    const minutes = Number(durationMatch[2]);
    const seconds = Number(durationMatch[3]);
    const duration = (hours * 3600) + (minutes * 60) + seconds;
    if (Number.isFinite(duration) && duration > 0) return duration;
  }

  const timeMatches = [...stderr.matchAll(/time=(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/gi)];
  if (timeMatches.length) {
    const last = timeMatches[timeMatches.length - 1];
    const hours = Number(last[1]);
    const minutes = Number(last[2]);
    const seconds = Number(last[3]);
    const duration = (hours * 3600) + (minutes * 60) + seconds;
    if (Number.isFinite(duration) && duration > 0) return duration;
  }

  return 0;
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
    }, 25_000);

    child.stderr.on("data", (chunk) => {
      if (stderr.length < 2_000_000) stderr += chunk.toString();
    });

    child.on("error", (error) => {
      if (error.code === "ENOENT") {
        finish(reject, new Error("FFmpeg indisponível. Execute npm install na raiz da API para instalar o binário empacotado."));
      } else {
        finish(reject, error);
      }
    });

    child.on("close", () => {
      const duration = parseFfmpegDuration(stderr);
      const hasVideo = /Stream[^\n]*Video:/i.test(stderr);
      const hasAudio = /Stream[^\n]*Audio:/i.test(stderr);

      if (!hasVideo) {
        finish(reject, new Error("O arquivo enviado não possui uma faixa de vídeo válida"));
        return;
      }

      if (!Number.isFinite(duration) || duration <= 0) {
        finish(reject, new Error("Não foi possível identificar a duração do vídeo com FFmpeg"));
        return;
      }

      finish(resolve, { duration, hasAudio });
    });
  });
}

async function downloadSource(sourceUrl, targetPath) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);

  try {
    const response = await fetch(sourceUrl, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Falha ao baixar vídeo de origem (${response.status})`);
    }

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.toLowerCase().includes("video")) {
      throw new Error("O arquivo de origem não foi identificado como vídeo");
    }

    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength > MAX_SOURCE_BYTES) {
      throw new Error("Vídeo de origem excede 120MB");
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_SOURCE_BYTES) {
      throw new Error("Vídeo de origem excede 120MB");
    }

    await writeFile(targetPath, buffer);
  } finally {
    clearTimeout(timeout);
  }
}

function buildScaleFilter(width, height, fit) {
  if (fit === "contain") {
    return [
      `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`,
    ];
  }

  return [
    `scale=${width}:${height}:force_original_aspect_ratio=increase`,
    `crop=${width}:${height}`,
  ];
}

function buildTransformFilters(settings, width, height) {
  const filters = [];

  if (settings.rotation === 90) filters.push("transpose=1");
  if (settings.rotation === 180) filters.push("hflip", "vflip");
  if (settings.rotation === 270) filters.push("transpose=2");
  if (settings.flipX) filters.push("hflip");
  if (settings.flipY) filters.push("vflip");

  filters.push(...buildScaleFilter(width, height, settings.fit));
  filters.push(`fps=${settings.renderFps || 30}`, "format=yuv420p", "settb=AVTB");
  return filters;
}

function buildEffectFilters(settings) {
  const filters = [];
  const intensity = clamp(settings.effectIntensity, 0, 1);

  filters.push(
    `eq=brightness=${settings.brightness.toFixed(3)}:contrast=${settings.contrast.toFixed(3)}:saturation=${settings.saturation.toFixed(3)}`
  );

  if (settings.blur > 0.01) {
    filters.push(`gblur=sigma=${settings.blur.toFixed(2)}`);
  }

  switch (settings.effect) {
    case "cinematic":
      filters.push(`eq=brightness=${(-0.025 * intensity).toFixed(3)}:contrast=${(1 + 0.16 * intensity).toFixed(3)}:saturation=${(1 - 0.14 * intensity).toFixed(3)}`);
      filters.push(`vignette=PI/${(8 - 3 * intensity).toFixed(2)}`);
      break;
    case "vivid":
      filters.push(`eq=contrast=${(1 + 0.1 * intensity).toFixed(3)}:saturation=${(1 + 0.45 * intensity).toFixed(3)}`);
      filters.push(`unsharp=5:5:${(0.35 * intensity).toFixed(2)}:5:5:0`);
      break;
    case "warm":
      filters.push(`colorbalance=rs=${(0.10 * intensity).toFixed(3)}:gs=${(0.035 * intensity).toFixed(3)}:bs=${(-0.07 * intensity).toFixed(3)}`);
      break;
    case "cool":
      filters.push(`colorbalance=rs=${(-0.065 * intensity).toFixed(3)}:gs=${(0.01 * intensity).toFixed(3)}:bs=${(0.10 * intensity).toFixed(3)}`);
      break;
    case "noir":
      filters.push("hue=s=0");
      filters.push(`eq=contrast=${(1 + 0.28 * intensity).toFixed(3)}:brightness=${(-0.035 * intensity).toFixed(3)}`);
      break;
    case "vintage":
      filters.push(`colorbalance=rs=${(0.08 * intensity).toFixed(3)}:gs=${(0.035 * intensity).toFixed(3)}:bs=${(-0.055 * intensity).toFixed(3)}`);
      filters.push(`eq=saturation=${(1 - 0.22 * intensity).toFixed(3)}:contrast=${(1 - 0.06 * intensity).toFixed(3)}`);
      filters.push(`vignette=PI/${(9 - 4 * intensity).toFixed(2)}`);
      break;
    case "dream":
      filters.push(`gblur=sigma=${(1.2 * intensity).toFixed(2)}`);
      filters.push(`eq=brightness=${(0.055 * intensity).toFixed(3)}:saturation=${(1 - 0.08 * intensity).toFixed(3)}`);
      break;
    case "sharp":
      filters.push(`unsharp=5:5:${(1.0 * intensity).toFixed(2)}:5:5:${(0.08 * intensity).toFixed(2)}`);
      break;
    case "grain":
      filters.push(`noise=alls=${Math.max(1, Math.round(13 * intensity))}:allf=t+u`);
      break;
    case "vignette":
      filters.push(`vignette=PI/${(9 - 5 * intensity).toFixed(2)}`);
      break;
    case "soft":
      filters.push(`gblur=sigma=${(0.75 * intensity).toFixed(2)}`);
      filters.push(`eq=brightness=${(0.035 * intensity).toFixed(3)}:contrast=${(1 - 0.08 * intensity).toFixed(3)}`);
      break;
    default:
      break;
  }

  if (settings.fadeIn > 0.01) {
    filters.push(`fade=t=in:st=0:d=${settings.fadeIn.toFixed(3)}`);
  }

  if (settings.fadeOut > 0.01) {
    const start = Math.max(0, settings.outputDuration - settings.fadeOut);
    filters.push(`fade=t=out:st=${start.toFixed(3)}:d=${settings.fadeOut.toFixed(3)}`);
  }

  return filters;
}

function buildAudioFilters(settings) {
  const filters = [];

  if (Math.abs(settings.volume - 1) > 0.001) {
    filters.push(`volume=${settings.volume.toFixed(3)}`);
  }

  if (settings.fadeIn > 0.01) {
    filters.push(`afade=t=in:st=0:d=${settings.fadeIn.toFixed(3)}`);
  }

  if (settings.fadeOut > 0.01) {
    const start = Math.max(0, settings.outputDuration - settings.fadeOut);
    filters.push(`afade=t=out:st=${start.toFixed(3)}:d=${settings.fadeOut.toFixed(3)}`);
  }

  return filters;
}

function normalizeSegments(rawSegments, duration, fallbackStart, fallbackEnd, speed) {
  const source = Array.isArray(rawSegments) && rawSegments.length
    ? rawSegments.slice(0, MAX_SEGMENTS)
    : [{ start: fallbackStart, end: fallbackEnd, transition: "none", transitionDuration: 0 }];

  const segments = source.map((segment, index) => {
    const start = clamp(asNumber(segment?.start, 0), 0, Math.max(0, duration - 0.1));
    const end = clamp(asNumber(segment?.end, duration), start + 0.1, duration);
    const transition = ALLOWED_TRANSITIONS.has(segment?.transition) ? segment.transition : "none";
    const segmentOutputDuration = (end - start) / speed;
    const maxTransition = Math.max(0.01, Math.min(1.2, segmentOutputDuration / 2));

    return {
      id: String(segment?.id || `segment-${index + 1}`),
      start,
      end,
      transition,
      transitionDuration: transition === "none"
        ? 0.01
        : clamp(asNumber(segment?.transitionDuration, 0.35), 0.08, maxTransition),
      sourceDuration: end - start,
      outputDuration: segmentOutputDuration,
    };
  }).filter((segment) => segment.end - segment.start >= 0.1);

  if (!segments.length) {
    throw new Error("A edição precisa manter pelo menos um trecho do vídeo");
  }

  const sourceTotal = segments.reduce((sum, segment) => sum + segment.sourceDuration, 0);
  if (sourceTotal > 60) {
    throw new Error("O editor de banners permite até 60 segundos somando todos os cortes");
  }

  let cumulative = segments[0].outputDuration;
  segments[0].timelineStart = 0;

  for (let i = 1; i < segments.length; i += 1) {
    const previous = segments[i - 1];
    const overlap = Math.min(
      previous.transitionDuration,
      previous.outputDuration / 2,
      segments[i].outputDuration / 2
    );
    previous.effectiveTransitionDuration = Math.max(0.01, overlap);
    segments[i].timelineStart = Math.max(0, cumulative - previous.effectiveTransitionDuration);
    cumulative = segments[i].timelineStart + segments[i].outputDuration;
  }

  if (segments.length) {
    segments[segments.length - 1].effectiveTransitionDuration = 0;
  }

  return { segments, outputDuration: cumulative };
}

function normalizeCaptionStyle(raw = {}) {
  const position = ["top", "center", "bottom"].includes(raw.position) ? raw.position : "bottom";
  const preset = ["classic", "bold", "minimal", "neon"].includes(raw.preset) ? raw.preset : "classic";
  const fontSize = clamp(asNumber(raw.fontSize, 54), 28, 86);
  const opacity = clamp(asNumber(raw.backgroundOpacity, 0.62), 0, 0.95);
  return { position, preset, fontSize, backgroundOpacity: opacity };
}

function normalizeCaptions(rawCaptions = [], duration) {
  if (!Array.isArray(rawCaptions)) return [];

  return rawCaptions.slice(0, MAX_CAPTIONS).map((caption, index) => {
    const start = clamp(asNumber(caption?.start, 0), 0, duration);
    const end = clamp(asNumber(caption?.end, Math.min(duration, start + 2)), start + 0.05, duration);
    const text = String(caption?.text || "").replace(/[\u0000-\u001F\u007F]/g, " ").trim().slice(0, 220);
    return {
      id: String(caption?.id || `caption-${index + 1}`),
      start,
      end,
      text,
    };
  }).filter((caption) => caption.text && caption.end > caption.start);
}

function getRenderProfile(quality, isMobile) {
  if (quality === "high") {
    return {
      width: isMobile ? 1080 : 1920,
      height: isMobile ? 1920 : 700,
      fps: 30,
      targetMb: 11.5,
      audioKbps: 96,
      preset: "veryfast",
      maxVideoKbps: isMobile ? 4200 : 5000,
    };
  }

  if (quality === "compact") {
    return {
      width: isMobile ? 540 : 1280,
      height: isMobile ? 960 : 466,
      fps: 24,
      targetMb: 4.8,
      audioKbps: 72,
      preset: "ultrafast",
      maxVideoKbps: isMobile ? 2000 : 2500,
    };
  }

  return {
    width: isMobile ? 720 : 1600,
    height: isMobile ? 1280 : 584,
    fps: 24,
    targetMb: 7.5,
    audioKbps: 96,
    preset: "superfast",
    maxVideoKbps: isMobile ? 2800 : 3400,
  };
}

function calculateRenderBitrate(duration, profile, hasAudio) {
  const safeDuration = Math.max(0.5, Number(duration) || 0.5);
  const audioKbps = hasAudio ? profile.audioKbps : 0;

  // Reservamos margem para container/metadata para o MP4 final ficar
  // confortavelmente abaixo do limite de 15MB sem uma segunda recodificação.
  const usableBits = profile.targetMb * 1024 * 1024 * 8 * 0.94;
  const totalKbps = usableBits / safeDuration / 1000;
  const videoKbps = Math.round(clamp(totalKbps - audioKbps, 320, profile.maxVideoKbps));

  return {
    audioKbps,
    videoKbps,
    maxrateKbps: Math.max(videoKbps, Math.round(videoKbps * 1.08)),
    bufsizeKbps: Math.max(640, Math.round(videoKbps * 2)),
  };
}

function normalizeSettings(raw = {}, duration, mediaType) {
  const trimStart = clamp(asNumber(raw.trimStart, 0), 0, Math.max(0, duration - 0.1));
  const trimEnd = clamp(asNumber(raw.trimEnd, duration), trimStart + 0.1, duration);
  const speed = clamp(asNumber(raw.speed, 1), 0.5, 2);
  const normalizedSegments = normalizeSegments(raw.segments, duration, trimStart, trimEnd, speed);
  const outputDuration = normalizedSegments.outputDuration;
  const maxFade = Math.max(0, Math.min(3, outputDuration / 2));

  return {
    trimStart,
    trimEnd,
    speed,
    volume: clamp(asNumber(raw.volume, 1), 0, 1),
    muted: raw.muted === true,
    brightness: clamp(asNumber(raw.brightness, 0), -0.5, 0.5),
    contrast: clamp(asNumber(raw.contrast, 1), 0.5, 1.5),
    saturation: clamp(asNumber(raw.saturation, 1), 0, 2),
    blur: clamp(asNumber(raw.blur, 0), 0, 8),
    fadeIn: clamp(asNumber(raw.fadeIn, 0), 0, maxFade),
    fadeOut: clamp(asNumber(raw.fadeOut, 0), 0, maxFade),
    rotation: normalizeRotation(raw.rotation),
    flipX: raw.flipX === true,
    flipY: raw.flipY === true,
    fit: raw.fit === "contain" ? "contain" : "cover",
    quality: ["high", "standard", "compact"].includes(raw.quality) ? raw.quality : "standard",
    mediaType: mediaType === "mobile_video" ? "mobile_video" : "desktop_video",
    effect: ALLOWED_EFFECTS.has(raw.effect) ? raw.effect : "original",
    effectIntensity: clamp(asNumber(raw.effectIntensity, 0.8), 0, 1),
    captionStyle: normalizeCaptionStyle(raw.captionStyle),
    captions: normalizeCaptions(raw.captions, duration),
    segments: normalizedSegments.segments,
    outputDuration,
  };
}

function mapCaptionsToTimeline(captions, segments, speed) {
  const mapped = [];

  for (const caption of captions) {
    for (const segment of segments) {
      const overlapStart = Math.max(caption.start, segment.start);
      const overlapEnd = Math.min(caption.end, segment.end);
      if (overlapEnd <= overlapStart) continue;

      const start = segment.timelineStart + ((overlapStart - segment.start) / speed);
      const end = segment.timelineStart + ((overlapEnd - segment.start) / speed);
      if (end - start < 0.04) continue;

      mapped.push({
        id: `${caption.id}-${segment.id}`,
        text: caption.text,
        start,
        end,
      });
    }
  }

  return mapped.slice(0, MAX_CAPTIONS);
}

function escapeXml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function wrapCaption(text, maxChars) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxChars || !current) {
      current = candidate;
      continue;
    }
    lines.push(current);
    current = word;
    if (lines.length >= 2) break;
  }

  if (current && lines.length < 3) lines.push(current);
  if (lines.length === 3 && words.join(" ").length > lines.join(" ").length) {
    lines[2] = `${lines[2].slice(0, Math.max(1, maxChars - 1))}…`;
  }
  return lines.slice(0, 3);
}

async function createCaptionImage(caption, style, width, tmpDir, index) {
  const fontSize = style.fontSize;
  const imageWidth = Math.round(width * 0.88);
  const maxChars = Math.max(14, Math.floor(imageWidth / (fontSize * 0.58)));
  const lines = wrapCaption(caption.text, maxChars);
  const lineHeight = Math.round(fontSize * 1.18);
  const verticalPadding = Math.round(fontSize * 0.42);
  const imageHeight = Math.max(90, verticalPadding * 2 + lineHeight * lines.length);

  const presetMap = {
    classic: { fill: "#ffffff", stroke: "#000000", strokeWidth: 3, box: `rgba(0,0,0,${style.backgroundOpacity})` },
    bold: { fill: "#ffffff", stroke: "#000000", strokeWidth: 5, box: `rgba(0,0,0,${Math.min(0.8, style.backgroundOpacity + 0.08)})` },
    minimal: { fill: "#ffffff", stroke: "#000000", strokeWidth: 2, box: `rgba(0,0,0,${Math.min(0.35, style.backgroundOpacity)})` },
    neon: { fill: "#8fffd0", stroke: "#02130d", strokeWidth: 4, box: `rgba(0,18,12,${Math.min(0.78, style.backgroundOpacity + 0.06)})` },
  };
  const visual = presetMap[style.preset] || presetMap.classic;
  const textStartY = verticalPadding + fontSize;

  const tspans = lines.map((line, lineIndex) => (
    `<tspan x="50%" y="${textStartY + lineIndex * lineHeight}">${escapeXml(line)}</tspan>`
  )).join("");

  const svg = `
    <svg width="${imageWidth}" height="${imageHeight}" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="0" width="${imageWidth}" height="${imageHeight}" rx="${Math.round(fontSize * 0.32)}" fill="${visual.box}"/>
      <text x="50%" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="${fontSize}" font-weight="800" fill="${visual.fill}" stroke="${visual.stroke}" stroke-width="${visual.strokeWidth}" paint-order="stroke fill" letter-spacing="0.3">
        ${tspans}
      </text>
    </svg>`;

  const filePath = path.join(tmpDir, `caption-${String(index).padStart(3, "0")}.png`);
  await sharp(Buffer.from(svg)).png().toFile(filePath);
  return { filePath, width: imageWidth, height: imageHeight };
}

function getCaptionY(style, outputHeight, imageHeight) {
  const safeMargin = Math.round(outputHeight * 0.07);
  if (style.position === "top") return safeMargin;
  if (style.position === "center") return Math.max(0, Math.round((outputHeight - imageHeight) / 2));
  return Math.max(0, outputHeight - imageHeight - safeMargin);
}

function buildFilterGraph(settings, metadata, width, height, captionAssets) {
  const graph = [];
  const transformFilters = buildTransformFilters(settings, width, height);

  settings.segments.forEach((segment, index) => {
    const videoFilters = [
      `trim=start=${segment.start.toFixed(3)}:end=${segment.end.toFixed(3)}`,
      "setpts=PTS-STARTPTS",
      ...transformFilters,
    ];
    if (Math.abs(settings.speed - 1) > 0.001) {
      videoFilters.push(`setpts=PTS/${settings.speed.toFixed(3)}`);
    }
    graph.push(`[0:v]${videoFilters.join(",")}[v${index}]`);

    if (metadata.hasAudio && !settings.muted) {
      const audioFilters = [
        `atrim=start=${segment.start.toFixed(3)}:end=${segment.end.toFixed(3)}`,
        "asetpts=PTS-STARTPTS",
      ];
      if (Math.abs(settings.speed - 1) > 0.001) {
        audioFilters.push(`atempo=${settings.speed.toFixed(3)}`);
      }
      audioFilters.push("aresample=async=1:first_pts=0");
      graph.push(`[0:a]${audioFilters.join(",")}[a${index}]`);
    }
  });

  let videoLabel = "v0";
  let audioLabel = metadata.hasAudio && !settings.muted ? "a0" : null;
  let cumulativeDuration = settings.segments[0].outputDuration;

  for (let index = 1; index < settings.segments.length; index += 1) {
    const previous = settings.segments[index - 1];
    const transitionDuration = Math.max(0.01, previous.effectiveTransitionDuration || 0.01);
    const transitionType = previous.transition === "none" ? "fade" : previous.transition;
    const offset = Math.max(0, cumulativeDuration - transitionDuration);
    const nextVideoLabel = `vx${index}`;

    graph.push(
      `[${videoLabel}][v${index}]xfade=transition=${transitionType}:duration=${transitionDuration.toFixed(3)}:offset=${offset.toFixed(3)}[${nextVideoLabel}]`
    );
    videoLabel = nextVideoLabel;

    if (audioLabel) {
      const nextAudioLabel = `ax${index}`;
      graph.push(
        `[${audioLabel}][a${index}]acrossfade=d=${transitionDuration.toFixed(3)}:c1=tri:c2=tri[${nextAudioLabel}]`
      );
      audioLabel = nextAudioLabel;
    }

    cumulativeDuration = offset + settings.segments[index].outputDuration;
  }

  const effectFilters = buildEffectFilters(settings);
  const effectedVideoLabel = "vfx";
  graph.push(`[${videoLabel}]${effectFilters.length ? effectFilters.join(",") : "null"}[${effectedVideoLabel}]`);
  videoLabel = effectedVideoLabel;

  captionAssets.forEach((asset, index) => {
    const nextLabel = `vsub${index}`;
    const y = getCaptionY(settings.captionStyle, height, asset.height);
    const inputIndex = index + 1;
    graph.push(
      `[${videoLabel}][${inputIndex}:v]overlay=x=(W-w)/2:y=${y}:enable='between(t,${asset.start.toFixed(3)},${asset.end.toFixed(3)})':shortest=1[${nextLabel}]`
    );
    videoLabel = nextLabel;
  });

  const finalVideoLabel = "vout";
  graph.push(`[${videoLabel}]format=yuv420p[${finalVideoLabel}]`);

  let finalAudioLabel = null;
  if (audioLabel) {
    const audioFilters = buildAudioFilters(settings);
    finalAudioLabel = "aout";
    graph.push(`[${audioLabel}]${audioFilters.length ? audioFilters.join(",") : "anull"}[${finalAudioLabel}]`);
  }

  return {
    filterGraph: graph.join(";"),
    finalVideoLabel,
    finalAudioLabel,
  };
}

async function uploadRenderedVideo(buffer, mediaType) {
  const filename = `${mediaType}-${Date.now()}-${crypto.randomUUID()}.mp4`;
  const storagePath = `videos/edited/${filename}`;

  const { error } = await supabaseAdmin.storage
    .from(BUCKET_NAME)
    .upload(storagePath, buffer, {
      contentType: "video/mp4",
      cacheControl: "31536000",
      upsert: false,
    });

  if (error) {
    throw new Error(`Falha ao salvar vídeo editado: ${error.message}`);
  }

  const { data } = supabaseAdmin.storage.from(BUCKET_NAME).getPublicUrl(storagePath);
  return {
    url: data.publicUrl,
    path: storagePath,
    filename,
  };
}

export async function transcribeBannerVideo({ sourceUrl, language = "auto" }) {
  const apiKey = String(process.env.OPENAI_API_KEY || "").trim();
  if (!apiKey) {
    const error = new Error("Legenda automática requer OPENAI_API_KEY configurada na API");
    error.statusCode = 503;
    error.code = "CAPTIONS_AI_NOT_CONFIGURED";
    throw error;
  }

  const safeSourceUrl = validateSourceUrl(sourceUrl);
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "ozonteck-banner-captions-"));
  const inputPath = path.join(tmpDir, "input.mp4");
  const audioPath = path.join(tmpDir, "audio.mp3");

  try {
    await downloadSource(safeSourceUrl, inputPath);
    const metadata = await inspectVideo(inputPath);
    if (!metadata.hasAudio) {
      throw new Error("Este vídeo não possui áudio para gerar legendas automáticas");
    }

    await runProcess(FFMPEG_BINARY, [
      "-hide_banner",
      "-loglevel", "error",
      "-i", inputPath,
      "-vn",
      "-ac", "1",
      "-ar", "16000",
      "-b:a", "64k",
      "-c:a", "libmp3lame",
      "-y", audioPath,
    ], 90_000);

    const client = new OpenAI({ apiKey });
    const request = {
      file: createReadStream(audioPath),
      model: "whisper-1",
      response_format: "verbose_json",
      timestamp_granularities: ["segment"],
    };
    if (language && language !== "auto") request.language = language;

    const transcription = await client.audio.transcriptions.create(request);
    const rawSegments = Array.isArray(transcription?.segments) ? transcription.segments : [];

    const captions = rawSegments
      .slice(0, MAX_CAPTIONS)
      .map((segment, index) => ({
        id: `ai-caption-${index + 1}`,
        start: clamp(asNumber(segment.start, 0), 0, metadata.duration),
        end: clamp(asNumber(segment.end, 0), 0, metadata.duration),
        text: String(segment.text || "").trim(),
      }))
      .filter((caption) => caption.text && caption.end > caption.start);

    if (!captions.length && transcription?.text) {
      captions.push({
        id: "ai-caption-1",
        start: 0,
        end: metadata.duration,
        text: String(transcription.text).trim(),
      });
    }

    return {
      captions,
      language: transcription?.language || language || "auto",
      duration: metadata.duration,
    };
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function renderBannerVideo({ sourceUrl, mediaType, rawSettings }) {
  const safeSourceUrl = validateSourceUrl(sourceUrl);
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "ozonteck-banner-editor-"));
  const inputPath = path.join(tmpDir, "input.mp4");
  const outputPath = path.join(tmpDir, "output.mp4");

  try {
    await downloadSource(safeSourceUrl, inputPath);
    const metadata = await inspectVideo(inputPath);
    const settings = normalizeSettings(rawSettings, metadata.duration, mediaType);

    const isMobile = settings.mediaType === "mobile_video";
    const renderProfile = getRenderProfile(settings.quality, isMobile);
    const width = renderProfile.width;
    const height = renderProfile.height;
    settings.renderFps = renderProfile.fps;
    const mappedCaptions = mapCaptionsToTimeline(settings.captions, settings.segments, settings.speed);
    const captionAssets = [];

    for (let index = 0; index < mappedCaptions.length; index += 1) {
      const caption = mappedCaptions[index];
      const image = await createCaptionImage(caption, settings.captionStyle, width, tmpDir, index);
      captionAssets.push({ ...caption, ...image });
    }

    const { filterGraph, finalVideoLabel, finalAudioLabel } = buildFilterGraph(
      settings,
      metadata,
      width,
      height,
      captionAssets
    );

    const args = [
      "-hide_banner",
      "-loglevel", "error",
      "-i", inputPath,
    ];

    captionAssets.forEach((caption) => {
      args.push("-loop", "1", "-framerate", String(renderProfile.fps), "-i", caption.filePath);
    });

    const bitrate = calculateRenderBitrate(
      settings.outputDuration,
      renderProfile,
      Boolean(finalAudioLabel)
    );

    args.push(
      "-filter_complex", filterGraph,
      "-map", `[${finalVideoLabel}]`,
      "-c:v", "libx264",
      "-preset", renderProfile.preset,
      "-b:v", `${bitrate.videoKbps}k`,
      "-maxrate", `${bitrate.maxrateKbps}k`,
      "-bufsize", `${bitrate.bufsizeKbps}k`,
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      "-threads", "0",
      "-max_muxing_queue_size", "1024",
      "-t", settings.outputDuration.toFixed(3)
    );

    if (finalAudioLabel) {
      args.push(
        "-map", `[${finalAudioLabel}]`,
        "-c:a", "aac",
        "-b:a", `${bitrate.audioKbps}k`,
        "-ac", "2"
      );
    } else {
      args.push("-an");
    }

    args.push("-y", outputPath);
    await runProcess(FFMPEG_BINARY, args);

    let outputBuffer = await readFile(outputPath);
    if (!outputBuffer.length) {
      throw new Error("FFmpeg gerou um arquivo vazio");
    }

    if (outputBuffer.length > MAX_FINAL_VIDEO_BYTES) {
      throw new Error(
        "O vídeo renderizado ultrapassou 15MB. Use qualidade Padrão/Compacta ou reduza a duração do projeto."
      );
    }

    const uploaded = await uploadRenderedVideo(outputBuffer, settings.mediaType);
    return {
      ...uploaded,
      width,
      height,
      duration: Number(settings.outputDuration.toFixed(3)),
      size: outputBuffer.length,
      settings: {
        ...settings,
        renderProfile: {
          width,
          height,
          fps: renderProfile.fps,
          preset: renderProfile.preset,
          targetMb: renderProfile.targetMb,
          videoKbps: bitrate.videoKbps,
          audioKbps: bitrate.audioKbps,
        },
        captions: settings.captions.length,
        segments: settings.segments.map((segment) => ({
          id: segment.id,
          start: segment.start,
          end: segment.end,
          transition: segment.transition,
          transitionDuration: segment.effectiveTransitionDuration || 0,
        })),
      },
    };
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
