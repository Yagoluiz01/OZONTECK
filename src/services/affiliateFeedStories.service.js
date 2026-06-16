import crypto from "crypto";
import { env } from "../config/env.js";

const SUPABASE_URL = String(env.supabaseUrl || "").replace(/\/+$/, "");
const SERVICE_ROLE_KEY = env.supabaseServiceRoleKey;

const STORY_VIDEO_BUCKET = process.env.AFFILIATE_STORY_VIDEOS_BUCKET || "affiliate-story-videos";
const STORY_VIDEO_MAX_BYTES = Number(process.env.AFFILIATE_STORY_VIDEO_MAX_BYTES || 20 * 1024 * 1024);
const STORY_VIDEO_MAX_SECONDS = Number(process.env.AFFILIATE_STORY_VIDEO_MAX_SECONDS || 60);
const STORY_DEFAULT_HOURS = Number(process.env.AFFILIATE_STORY_DEFAULT_HOURS || 24);
const STORY_LIMIT_PUBLIC = Number(process.env.AFFILIATE_STORY_PUBLIC_LIMIT || 24);
const SIGNED_VIDEO_EXPIRES_IN = Number(process.env.AFFILIATE_STORY_SIGNED_VIDEO_EXPIRES_IN || 60 * 60);

const ALLOWED_STATUS = new Set(["pending", "approved", "rejected", "hidden", "banned"]);
const ALLOWED_VIDEO_MIMES = new Set(["video/mp4", "video/webm"]);
const ALLOWED_VIDEO_EXTENSIONS = new Map([
  ["video/mp4", "mp4"],
  ["video/webm", "webm"],
]);

const STORY_ALLOWED_HOSTS = String(
  process.env.AFFILIATE_STORY_ALLOWED_VIDEO_HOSTS ||
    "res.cloudinary.com,player.vimeo.com,vimeo.com,youtube.com,www.youtube.com,youtu.be,storage.googleapis.com,supabase.co"
)
  .split(",")
  .map((item) => item.trim().toLowerCase())
  .filter(Boolean);

const PUBLIC_STORY_SELECT = [
  "id",
  "affiliate_id",
  "affiliate_name",
  "affiliate_avatar_url",
  "title",
  "description",
  "video_url",
  "video_path",
  "video_mime_type",
  "video_size_bytes",
  "video_source",
  "thumbnail_url",
  "status",
  "is_pinned",
  "is_official",
  "expires_at",
  "created_at",
  "updated_at",
].join(",");

const ADMIN_STORY_SELECT = [
  "id",
  "affiliate_id",
  "affiliate_name",
  "affiliate_avatar_url",
  "title",
  "description",
  "video_url",
  "video_path",
  "video_mime_type",
  "video_size_bytes",
  "video_source",
  "thumbnail_url",
  "status",
  "is_pinned",
  "is_official",
  "approved_at",
  "approved_by",
  "rejected_reason",
  "expires_at",
  "metadata",
  "created_at",
  "updated_at",
].join(",");

function assertSupabaseConfig() {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    const error = new Error("Configuração do Supabase ausente para os stories da comunidade.");
    error.statusCode = 500;
    throw error;
  }
}

function getHeaders(extra = {}) {
  assertSupabaseConfig();

  return {
    apikey: SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

async function supabaseRequest(path, options = {}) {
  assertSupabaseConfig();

  const method = String(options.method || "GET").toUpperCase();
  const headers = getHeaders(options.headers || {});

  if (["POST", "PUT", "PATCH", "DELETE"].includes(method) && !headers.Prefer) {
    headers.Prefer = "return=representation";
  }

  const response = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    ...options,
    method,
    headers,
  });

  const text = await response.text();
  let data = null;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!response.ok) {
    const message =
      data?.message ||
      data?.error_description ||
      data?.hint ||
      data?.details ||
      `Erro Supabase nos stories da comunidade: ${response.status}`;

    const error = new Error(message);
    error.statusCode = response.status;
    throw error;
  }

  return data;
}

function cleanText(value) {
  return String(value || "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\r\n/g, "\n")
    .trim();
}

function limitNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(number)));
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{12}$/i.test(String(value || ""));
}

function assertUuid(value, label = "ID") {
  const cleanValue = cleanText(value);

  if (!isUuid(cleanValue)) {
    const error = new Error(`${label} inválido.`);
    error.statusCode = 400;
    throw error;
  }

  return cleanValue;
}

function sanitizeStatus(value, fallback = "pending") {
  const status = cleanText(value || fallback).toLowerCase();
  return ALLOWED_STATUS.has(status) ? status : fallback;
}

function sanitizeTitle(value) {
  const title = cleanText(value || "").slice(0, 90);

  if (title.length < 3) {
    const error = new Error("Informe um título para o story de vídeo.");
    error.statusCode = 400;
    throw error;
  }

  return title;
}

function sanitizeDescription(value) {
  return cleanText(value || "").slice(0, 700);
}

function encodeStoragePath(value) {
  return String(value || "")
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function sanitizeThumbnailUrl(value) {
  const url = cleanText(value || "");
  if (!url) return null;
  return sanitizeHttpsUrl(url, { requireVideo: false });
}

function isAllowedStoryHost(hostname) {
  const safeHost = String(hostname || "").toLowerCase().replace(/^www\./, "");

  return STORY_ALLOWED_HOSTS.some((allowed) => {
    const normalized = allowed.replace(/^www\./, "");
    return safeHost === normalized || safeHost.endsWith(`.${normalized}`);
  });
}

function sanitizeHttpsUrl(value, { requireVideo = true } = {}) {
  const raw = cleanText(value);

  if (raw.length > 1200) {
    const error = new Error("URL do vídeo muito longa.");
    error.statusCode = 400;
    throw error;
  }

  let parsed = null;

  try {
    parsed = new URL(raw);
  } catch {
    const error = new Error("URL do vídeo inválida.");
    error.statusCode = 400;
    throw error;
  }

  if (parsed.protocol !== "https:") {
    const error = new Error("Use apenas links HTTPS para stories.");
    error.statusCode = 400;
    throw error;
  }

  if (!isAllowedStoryHost(parsed.hostname)) {
    const error = new Error("Domínio do vídeo não permitido para stories.");
    error.statusCode = 400;
    throw error;
  }

  if (requireVideo) {
    const path = parsed.pathname.toLowerCase();
    const isDirectVideo = /\.(mp4|webm|m4v|mov)$/i.test(path);
    const isKnownPlayer =
      parsed.hostname.includes("youtube") ||
      parsed.hostname.includes("youtu.be") ||
      parsed.hostname.includes("vimeo") ||
      parsed.hostname.includes("cloudinary");

    if (!isDirectVideo && !isKnownPlayer) {
      const error = new Error("Use um link direto de vídeo MP4/WEBM ou um player confiável.");
      error.statusCode = 400;
      throw error;
    }
  }

  parsed.hash = "";
  return parsed.toString();
}

function parseBase64Video(payload = {}) {
  const raw =
    cleanText(payload.video_base64 || payload.videoBase64 || payload.base64 || payload.file_base64 || "");

  if (!raw) return null;

  let mimeType = cleanText(payload.mimeType || payload.mime_type || payload.video_mime_type || "video/mp4").toLowerCase();
  let base64 = raw;

  const dataUrlMatch = raw.match(/^data:([^;]+);base64,(.+)$/i);
  if (dataUrlMatch) {
    mimeType = cleanText(dataUrlMatch[1]).toLowerCase();
    base64 = dataUrlMatch[2];
  }

  if (!ALLOWED_VIDEO_MIMES.has(mimeType)) {
    const error = new Error("Formato de vídeo não permitido. Use MP4 ou WEBM.");
    error.statusCode = 400;
    throw error;
  }

  if (!/^[A-Za-z0-9+/=\s]+$/.test(base64)) {
    const error = new Error("Arquivo de vídeo inválido.");
    error.statusCode = 400;
    throw error;
  }

  const buffer = Buffer.from(base64.replace(/\s+/g, ""), "base64");

  if (!buffer.length || buffer.length > STORY_VIDEO_MAX_BYTES) {
    const error = new Error(`Vídeo muito grande. Envie um vídeo de até ${Math.floor(STORY_VIDEO_MAX_BYTES / 1024 / 1024)} MB.`);
    error.statusCode = 413;
    throw error;
  }

  validateVideoMagic(buffer, mimeType);

  return {
    buffer,
    mimeType,
    extension: ALLOWED_VIDEO_EXTENSIONS.get(mimeType) || "mp4",
    size: buffer.length,
  };
}

function validateVideoMagic(buffer, mimeType) {
  if (mimeType === "video/webm") {
    const isWebm = buffer.length > 4 && buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3;
    if (!isWebm) {
      const error = new Error("Arquivo WEBM inválido.");
      error.statusCode = 400;
      throw error;
    }
    return;
  }

  if (mimeType === "video/mp4") {
    const signature = buffer.slice(4, 12).toString("ascii");
    if (!signature.includes("ftyp")) {
      const error = new Error("Arquivo MP4 inválido.");
      error.statusCode = 400;
      throw error;
    }
  }
}

async function uploadStoryVideo({ affiliateId, videoPayload }) {
  const parsedVideo = parseBase64Video(videoPayload);
  if (!parsedVideo) return null;

  const safeAffiliateId = assertUuid(affiliateId, "Afiliado");
  const objectPath = `${safeAffiliateId}/${Date.now()}-${crypto.randomBytes(8).toString("hex")}.${parsedVideo.extension}`;

  const response = await fetch(`${SUPABASE_URL}/storage/v1/object/${STORY_VIDEO_BUCKET}/${encodeStoragePath(objectPath)}`, {
    method: "POST",
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": parsedVideo.mimeType,
      "Cache-Control": "604800",
      "x-upsert": "false",
    },
    body: parsedVideo.buffer,
  });

  const text = await response.text();
  let data = null;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!response.ok) {
    const error = new Error(data?.message || data?.error || "Erro ao enviar vídeo do story. Verifique o bucket affiliate-story-videos.");
    error.statusCode = response.status;
    throw error;
  }

  return {
    path: objectPath,
    mimeType: parsedVideo.mimeType,
    sizeBytes: parsedVideo.size,
  };
}

async function createSignedVideoUrl(videoPath) {
  const cleanPath = cleanText(videoPath);

  if (!cleanPath || cleanPath.includes("..") || cleanPath.startsWith("/")) {
    return null;
  }

  const response = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/${STORY_VIDEO_BUCKET}/${encodeStoragePath(cleanPath)}`, {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify({ expiresIn: SIGNED_VIDEO_EXPIRES_IN }),
  });

  const text = await response.text();
  let data = null;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!response.ok || !data?.signedURL) {
    return null;
  }

  const signedUrl = String(data.signedURL || "");
  return signedUrl.startsWith("http") ? signedUrl : `${SUPABASE_URL}/storage/v1${signedUrl}`;
}

async function deleteStorageObjects(paths = []) {
  const cleanPaths = Array.from(
    new Set(
      (Array.isArray(paths) ? paths : [])
        .map((item) => cleanText(item))
        .filter((item) => item && !item.includes("..") && !item.startsWith("/"))
    )
  );

  if (!cleanPaths.length) return;

  try {
    await fetch(`${SUPABASE_URL}/storage/v1/object/${STORY_VIDEO_BUCKET}/remove`, {
      method: "POST",
      headers: getHeaders(),
      body: JSON.stringify({ prefixes: cleanPaths }),
    });
  } catch (error) {
    console.warn("AFFILIATE_STORY_STORAGE_CLEANUP_WARN:", error?.message || error);
  }
}

export async function cleanupExpiredAffiliateFeedStories() {
  const nowIso = new Date().toISOString();

  const expiredRows = await supabaseRequest(
    `/affiliate_feed_stories?expires_at=lt.${encodeURIComponent(nowIso)}&select=id,video_path&limit=100`
  );

  const rows = Array.isArray(expiredRows) ? expiredRows : [];
  if (!rows.length) return { deleted: 0 };

  await deleteStorageObjects(rows.map((row) => row.video_path).filter(Boolean));

  const ids = rows
    .map((row) => row.id)
    .filter((id) => isUuid(id))
    .join(",");

  if (!ids) return { deleted: 0 };

  await supabaseRequest(`/affiliate_feed_stories?id=in.(${ids})`, {
    method: "DELETE",
  });

  return { deleted: rows.length };
}

function getAffiliateDisplayName(affiliate = {}) {
  return cleanText(
    affiliate.full_name ||
      affiliate.name ||
      affiliate.affiliate_name ||
      affiliate.email ||
      "Afiliado OZONTECK"
  ).slice(0, 120);
}

function getSafeAvatarUrl(value) {
  const raw = cleanText(value || "");
  if (!raw) return null;

  try {
    const parsed = new URL(raw);
    if (!["https:", "http:"].includes(parsed.protocol)) return null;
    return parsed.toString().slice(0, 1000);
  } catch {
    return null;
  }
}

async function normalizeStory(row = {}, { viewerId = null, includeInternalFields = false } = {}) {
  const signedVideoUrl = row.video_path ? await createSignedVideoUrl(row.video_path) : null;

  const safe = {
    id: row.id,
    affiliate_name: row.affiliate_name || "Afiliado OZONTECK",
    affiliate_avatar_url: getSafeAvatarUrl(row.affiliate_avatar_url),
    title: row.title || "Story de vídeo",
    description: row.description || "",
    video_url: signedVideoUrl || row.video_url || null,
    video_source: row.video_path ? "upload" : row.video_source || "link",
    video_mime_type: row.video_mime_type || null,
    video_size_bytes: row.video_size_bytes || null,
    thumbnail_url: row.thumbnail_url || null,
    status: row.status || "pending",
    is_pinned: Boolean(row.is_pinned),
    is_official: Boolean(row.is_official),
    expires_at: row.expires_at || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };

  if (viewerId && String(row.affiliate_id || "") === String(viewerId)) {
    safe.viewer_is_owner = true;
  }

  if (includeInternalFields) {
    safe.affiliate_id = row.affiliate_id || null;
    safe.video_path = row.video_path || null;
    safe.approved_at = row.approved_at || null;
    safe.approved_by = row.approved_by || null;
    safe.rejected_reason = row.rejected_reason || null;
    safe.metadata = row.metadata || {};
  } else if (["rejected", "hidden", "banned"].includes(safe.status)) {
    safe.rejected_reason = row.rejected_reason || null;
  }

  return safe;
}

function getDefaultExpiresAt() {
  const expires = new Date(Date.now() + STORY_DEFAULT_HOURS * 60 * 60 * 1000);
  return expires.toISOString();
}

export async function listAffiliateFeedStories(affiliateId, query = {}) {
  await cleanupExpiredAffiliateFeedStories();
  const safeAffiliateId = assertUuid(affiliateId, "Afiliado");
  const limit = limitNumber(query.limit, STORY_LIMIT_PUBLIC, 1, 60);
  const nowIso = new Date().toISOString();

  const approvedStories = await supabaseRequest(
    `/affiliate_feed_stories?status=eq.approved&or=(expires_at.is.null,expires_at.gte.${encodeURIComponent(
      nowIso
    )})&select=${PUBLIC_STORY_SELECT}&order=is_pinned.desc,created_at.desc&limit=${limit}`
  );

  const ownStories = await supabaseRequest(
    `/affiliate_feed_stories?affiliate_id=eq.${encodeURIComponent(
      safeAffiliateId
    )}&status=in.(pending,rejected,banned)&select=${PUBLIC_STORY_SELECT}&order=created_at.desc&limit=10`
  );

  const merged = new Map();

  [...(Array.isArray(ownStories) ? ownStories : []), ...(Array.isArray(approvedStories) ? approvedStories : [])].forEach((story) => {
    if (story?.id) merged.set(String(story.id), story);
  });

  return Promise.all(Array.from(merged.values()).map((story) => normalizeStory(story, { viewerId: safeAffiliateId })));
}

export async function createAffiliateFeedStory(affiliate = {}, payload = {}) {
  const affiliateId = assertUuid(affiliate.id || affiliate.affiliate_id, "Afiliado");
  const title = sanitizeTitle(payload.title || payload.name || "Story de vídeo");
  const description = sanitizeDescription(payload.description || payload.content || "");
  const thumbnailUrl = sanitizeThumbnailUrl(payload.thumbnail_url || payload.thumbnailUrl || "");
  const uploadedVideo = await uploadStoryVideo({ affiliateId, videoPayload: payload });

  let videoUrl = null;
  let videoSource = "upload";

  if (!uploadedVideo) {
    videoUrl = sanitizeHttpsUrl(payload.video_url || payload.videoUrl || payload.url || "");
    videoSource = "link";
  }

  const insertPayload = {
    affiliate_id: affiliateId,
    affiliate_name: getAffiliateDisplayName(affiliate),
    affiliate_avatar_url: getSafeAvatarUrl(affiliate.profile_photo_url || affiliate.avatar_url),
    title,
    description,
    video_url: videoUrl,
    video_path: uploadedVideo?.path || null,
    video_mime_type: uploadedVideo?.mimeType || null,
    video_size_bytes: uploadedVideo?.sizeBytes || null,
    video_source: videoSource,
    thumbnail_url: thumbnailUrl,
    status: "pending",
    is_pinned: false,
    is_official: false,
    expires_at: getDefaultExpiresAt(),
    metadata: {
      source: "affiliate_panel",
      max_seconds: STORY_VIDEO_MAX_SECONDS,
      uploaded_video: Boolean(uploadedVideo),
      submitted_at: new Date().toISOString(),
    },
  };

  const rows = await supabaseRequest("/affiliate_feed_stories", {
    method: "POST",
    body: JSON.stringify(insertPayload),
  });

  const story = Array.isArray(rows) ? rows[0] : rows;
  return normalizeStory(story, { viewerId: affiliateId });
}

export async function listAdminAffiliateFeedStories(query = {}) {
  await cleanupExpiredAffiliateFeedStories();
  const status = sanitizeStatus(query.status || "", "");
  const limit = limitNumber(query.limit, 50, 1, 100);
  const statusQuery = status ? `status=eq.${encodeURIComponent(status)}&` : "";

  const rows = await supabaseRequest(
    `/affiliate_feed_stories?${statusQuery}select=${ADMIN_STORY_SELECT}&order=is_pinned.desc,created_at.desc&limit=${limit}`
  );

  return Promise.all((Array.isArray(rows) ? rows : []).map((story) => normalizeStory(story, { includeInternalFields: true })));
}

export async function updateAdminAffiliateFeedStoryStatus(storyId, payload = {}, admin = {}) {
  const safeStoryId = assertUuid(storyId, "Story");
  const status = sanitizeStatus(payload.status, "pending");
  const reason = cleanText(payload.reason || payload.rejected_reason || "").slice(0, 500);

  const updatePayload = {
    status,
    rejected_reason: ["rejected", "hidden", "banned"].includes(status) ? reason || "Story moderado pela equipe." : null,
  };

  if (status === "approved") {
    updatePayload.approved_at = new Date().toISOString();
    updatePayload.approved_by = isUuid(admin.id || admin.user_id) ? admin.id || admin.user_id : null;
    updatePayload.rejected_reason = null;
  }

  if (payload.expires_at) {
    updatePayload.expires_at = new Date(payload.expires_at).toISOString();
  }

  const rows = await supabaseRequest(`/affiliate_feed_stories?id=eq.${encodeURIComponent(safeStoryId)}`, {
    method: "PATCH",
    body: JSON.stringify(updatePayload),
  });

  const row = Array.isArray(rows) ? rows[0] : rows;
  return normalizeStory(row, { includeInternalFields: true });
}

export async function updateAdminAffiliateFeedStoryPin(storyId, payload = {}) {
  const safeStoryId = assertUuid(storyId, "Story");
  const isPinned = Boolean(payload.is_pinned ?? payload.pinned ?? payload.pin);

  const rows = await supabaseRequest(`/affiliate_feed_stories?id=eq.${encodeURIComponent(safeStoryId)}`, {
    method: "PATCH",
    body: JSON.stringify({ is_pinned: isPinned }),
  });

  const row = Array.isArray(rows) ? rows[0] : rows;
  return normalizeStory(row, { includeInternalFields: true });
}
