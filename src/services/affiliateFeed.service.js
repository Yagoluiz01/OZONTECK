import crypto from "crypto";
import { env } from "../config/env.js";

const SUPABASE_URL = String(env.supabaseUrl || "").replace(/\/+$/, "");
const SERVICE_ROLE_KEY = env.supabaseServiceRoleKey;
const FEED_IMAGE_BUCKET = process.env.AFFILIATE_FEED_IMAGES_BUCKET || "affiliate-feed-images";
const FEED_IMAGE_MAX_BYTES = Number(process.env.AFFILIATE_FEED_IMAGE_MAX_BYTES || 3 * 1024 * 1024);
const FEED_IMAGE_MAX_OUTPUT_BYTES = Number(process.env.AFFILIATE_FEED_IMAGE_MAX_OUTPUT_BYTES || 1400 * 1024);
const FEED_IMAGE_MAX_SIDE = Number(process.env.AFFILIATE_FEED_IMAGE_MAX_SIDE || 1280);
const FEED_IMAGE_MAX_PIXELS = Number(process.env.AFFILIATE_FEED_IMAGE_MAX_PIXELS || 12000000);
const SIGNED_IMAGE_EXPIRES_IN = Number(process.env.AFFILIATE_FEED_SIGNED_IMAGE_EXPIRES_IN || 60 * 60);

const ALLOWED_POST_TYPES = new Set(["result", "tip", "ad", "announcement", "other"]);
const ALLOWED_STATUS = new Set(["pending", "approved", "rejected", "hidden", "banned"]);
const ALLOWED_IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);
const PUBLIC_STATUSES_OWN = new Set(["pending", "rejected", "banned"]);

const PUBLIC_POST_SELECT = [
  "id",
  "affiliate_id",
  "affiliate_name",
  "affiliate_avatar_url",
  "post_type",
  "content",
  "image_path",
  "status",
  "is_pinned",
  "is_official",
  "likes_count",
  "rejected_reason",
  "created_at",
  "updated_at",
].join(",");

const ADMIN_POST_SELECT = [
  "id",
  "affiliate_id",
  "affiliate_name",
  "affiliate_avatar_url",
  "post_type",
  "content",
  "image_path",
  "status",
  "is_pinned",
  "is_official",
  "likes_count",
  "approved_at",
  "approved_by",
  "rejected_reason",
  "metadata",
  "created_at",
  "updated_at",
].join(",");

let sharpLoadPromise = null;

function assertSupabaseConfig() {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    const error = new Error("Configuração do Supabase ausente para o feed dos afiliados.");
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
    Accept: "application/json",
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
      `Erro Supabase no feed dos afiliados: ${response.status}`;

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

function sanitizePostType(value) {
  const type = cleanText(value || "tip").toLowerCase();
  return ALLOWED_POST_TYPES.has(type) ? type : "tip";
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ""));
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

function sanitizeModerationReason(value) {
  const reason = cleanText(value);
  return reason.slice(0, 500);
}

function sanitizeContent(value) {
  const content = cleanText(value);

  if (content.length < 3) {
    const error = new Error("Escreva pelo menos 3 caracteres para publicar no feed.");
    error.statusCode = 400;
    throw error;
  }

  if (content.length > 2000) {
    const error = new Error("O texto do post pode ter no máximo 2000 caracteres.");
    error.statusCode = 400;
    throw error;
  }

  const dangerousPatterns = [
    /<\s*script/i,
    /javascript\s*:/i,
    /data\s*:\s*text\/html/i,
    /onerror\s*=/i,
    /onload\s*=/i,
  ];

  if (dangerousPatterns.some((pattern) => pattern.test(content))) {
    const error = new Error("Conteúdo bloqueado por segurança. Remova scripts, links suspeitos ou códigos HTML.");
    error.statusCode = 400;
    throw error;
  }

  return content;
}

function detectImageMime(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;

  const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (isJpeg) return "image/jpeg";

  const isPng =
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a;
  if (isPng) return "image/png";

  const isWebp = buffer.slice(0, 4).toString("ascii") === "RIFF" && buffer.slice(8, 12).toString("ascii") === "WEBP";
  if (isWebp) return "image/webp";

  return null;
}

function parseBase64Image(payload = {}) {
  const rawBase64 = cleanText(
    payload.image_base64 ||
      payload.imageBase64 ||
      payload.base64 ||
      payload.file ||
      payload.image ||
      ""
  );

  if (!rawBase64) return null;

  const mimeFromDataUrl = rawBase64.match(/^data:([^;]+);base64,/)?.[1]?.toLowerCase();
  const mimeType = cleanText(payload.mimeType || payload.mime_type || mimeFromDataUrl || "image/jpeg").toLowerCase();

  if (!ALLOWED_IMAGE_MIMES.has(mimeType)) {
    const error = new Error("Imagem inválida. Envie somente JPG, PNG ou WEBP.");
    error.statusCode = 400;
    throw error;
  }

  const cleanBase64 = rawBase64.includes(",") ? rawBase64.split(",").pop() : rawBase64;

  if (!/^[a-z0-9+/=\r\n]+$/i.test(cleanBase64 || "")) {
    const error = new Error("Imagem inválida. O arquivo enviado não parece ser base64 válido.");
    error.statusCode = 400;
    throw error;
  }

  if (cleanBase64.length > Math.ceil(FEED_IMAGE_MAX_BYTES * 1.38)) {
    const error = new Error("Imagem muito grande. Envie uma imagem de até 3 MB após otimização.");
    error.statusCode = 400;
    throw error;
  }

  const buffer = Buffer.from(cleanBase64, "base64");

  if (!buffer.length) {
    const error = new Error("Imagem inválida. Escolha outro arquivo.");
    error.statusCode = 400;
    throw error;
  }

  if (buffer.length > FEED_IMAGE_MAX_BYTES) {
    const error = new Error("Imagem muito grande. Envie uma imagem de até 3 MB após otimização.");
    error.statusCode = 400;
    throw error;
  }

  const detectedMime = detectImageMime(buffer);

  if (!detectedMime || detectedMime !== mimeType) {
    const error = new Error("Imagem bloqueada por segurança. O tipo real do arquivo não confere com o envio.");
    error.statusCode = 400;
    throw error;
  }

  return { buffer, mimeType: detectedMime };
}

async function loadSharp() {
  if (!sharpLoadPromise) {
    sharpLoadPromise = import("sharp")
      .then((mod) => mod.default || mod)
      .catch((error) => {
        sharpLoadPromise = null;
        throw error;
      });
  }

  return sharpLoadPromise;
}

async function convertImageBufferToWebp(parsedImage) {
  if (!parsedImage?.buffer) return null;

  let sharp = null;

  try {
    sharp = await loadSharp();
  } catch (error) {
    if (parsedImage.mimeType === "image/webp") {
      return {
        buffer: parsedImage.buffer,
        mimeType: "image/webp",
        extension: "webp",
        converted: false,
        conversion_note: "Imagem já estava em WEBP; conversão server-side não foi necessária.",
      };
    }

    const conversionError = new Error("Conversão para WEBP indisponível no servidor. Instale a dependência sharp na API antes de aceitar JPG/PNG.");
    conversionError.statusCode = 500;
    throw conversionError;
  }

  try {
    const pipeline = sharp(parsedImage.buffer, {
      limitInputPixels: FEED_IMAGE_MAX_PIXELS,
      animated: false,
      failOn: "warning",
    })
      .rotate()
      .resize({
        width: FEED_IMAGE_MAX_SIDE,
        height: FEED_IMAGE_MAX_SIDE,
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: 82, effort: 4 });

    let outputBuffer = await pipeline.toBuffer();

    if (outputBuffer.length > FEED_IMAGE_MAX_OUTPUT_BYTES) {
      outputBuffer = await sharp(parsedImage.buffer, {
        limitInputPixels: FEED_IMAGE_MAX_PIXELS,
        animated: false,
        failOn: "warning",
      })
        .rotate()
        .resize({
          width: Math.min(1080, FEED_IMAGE_MAX_SIDE),
          height: Math.min(1080, FEED_IMAGE_MAX_SIDE),
          fit: "inside",
          withoutEnlargement: true,
        })
        .webp({ quality: 72, effort: 5 })
        .toBuffer();
    }

    if (outputBuffer.length > FEED_IMAGE_MAX_OUTPUT_BYTES) {
      const error = new Error("Mesmo convertida para WEBP, a imagem ficou pesada. Envie uma imagem menor.");
      error.statusCode = 413;
      throw error;
    }

    return {
      buffer: outputBuffer,
      mimeType: "image/webp",
      extension: "webp",
      converted: true,
      original_mime_type: parsedImage.mimeType,
      original_size_bytes: parsedImage.buffer.length,
      output_size_bytes: outputBuffer.length,
    };
  } catch (error) {
    if (error.statusCode) throw error;

    const conversionError = new Error("Não foi possível converter a imagem para WEBP com segurança. Escolha outra imagem.");
    conversionError.statusCode = 400;
    throw conversionError;
  }
}

function encodeStoragePath(path = "") {
  return String(path || "")
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

async function uploadFeedImage({ affiliateId, imagePayload }) {
  const parsedImage = parseBase64Image(imagePayload);

  if (!parsedImage) return null;

  const safeAffiliateId = assertUuid(affiliateId, "Afiliado");
  const webpImage = await convertImageBufferToWebp(parsedImage);
  const objectPath = `${safeAffiliateId}/${Date.now()}-${crypto.randomBytes(8).toString("hex")}.webp`;

  const response = await fetch(`${SUPABASE_URL}/storage/v1/object/${FEED_IMAGE_BUCKET}/${encodeStoragePath(objectPath)}`, {
    method: "POST",
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "image/webp",
      "Cache-Control": "31536000, immutable",
      "x-upsert": "false",
    },
    body: webpImage.buffer,
  });

  const text = await response.text();
  let data = null;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!response.ok) {
    const error = new Error(data?.message || data?.error || "Erro ao enviar imagem do feed. Verifique o bucket affiliate-feed-images.");
    error.statusCode = response.status;
    throw error;
  }

  return {
    path: objectPath,
    metadata: {
      image_format: "webp",
      image_mime_type: "image/webp",
      image_original_mime_type: webpImage.original_mime_type || parsedImage.mimeType,
      image_original_size_bytes: webpImage.original_size_bytes || parsedImage.buffer.length,
      image_output_size_bytes: webpImage.output_size_bytes || webpImage.buffer.length,
      image_converted_server_side: Boolean(webpImage.converted),
    },
  };
}

async function createSignedImageUrl(imagePath) {
  const cleanPath = cleanText(imagePath);

  if (!cleanPath || cleanPath.includes("..") || cleanPath.startsWith("/")) {
    return null;
  }

  const response = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/${FEED_IMAGE_BUCKET}/${encodeStoragePath(cleanPath)}`, {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify({ expiresIn: SIGNED_IMAGE_EXPIRES_IN }),
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

function getAffiliateDisplayName(affiliate = {}) {
  return cleanText(affiliate.full_name || affiliate.name || affiliate.email || "Afiliado OZONTECK").slice(0, 120);
}

function getSafeAvatarUrl(value) {
  const url = cleanText(value);

  if (!url) return null;

  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

async function normalizePost(row = {}, viewerLikedIds = new Set(), options = {}) {
  const includeInternalFields = Boolean(options.includeInternalFields);
  const includeModerationFields = Boolean(options.includeModerationFields);
  const imageUrl = row.image_path ? await createSignedImageUrl(row.image_path) : null;

  const normalized = {
    id: row.id,
    affiliate_name: row.affiliate_name || "Afiliado OZONTECK",
    affiliate_avatar_url: getSafeAvatarUrl(row.affiliate_avatar_url),
    post_type: row.post_type || "tip",
    content: row.content || "",
    image_url: imageUrl,
    image_format: row.image_path ? "webp" : null,
    status: row.status || "pending",
    is_pinned: Boolean(row.is_pinned),
    is_official: Boolean(row.is_official),
    likes_count: Number(row.likes_count || 0),
    viewer_liked: viewerLikedIds.has(String(row.id || "")),
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };

  if (PUBLIC_STATUSES_OWN.has(row.status) || includeModerationFields) {
    normalized.rejected_reason = row.rejected_reason || null;
  }

  if (includeInternalFields) {
    normalized.affiliate_id = row.affiliate_id || null;
    normalized.approved_at = row.approved_at || null;
    normalized.approved_by = row.approved_by || null;
    normalized.metadata = row.metadata || {};
  }

  return normalized;
}

async function hydrateViewerLikes(posts = [], affiliateId) {
  const ids = posts.map((post) => String(post.id || "").trim()).filter(isUuid);

  if (!ids.length || !isUuid(affiliateId)) return new Set();

  const rows = await supabaseRequest(
    `/affiliate_feed_likes?affiliate_id=eq.${encodeURIComponent(affiliateId)}&post_id=in.(${ids.join(",")})&select=post_id`
  );

  return new Set((Array.isArray(rows) ? rows : []).map((row) => String(row.post_id || "")));
}

async function refreshPostLikesCount(postId) {
  const safePostId = assertUuid(postId, "Post");
  const likes = await supabaseRequest(
    `/affiliate_feed_likes?post_id=eq.${encodeURIComponent(safePostId)}&select=id`
  );

  const likesCount = Array.isArray(likes) ? likes.length : 0;

  const updated = await supabaseRequest(
    `/affiliate_feed_posts?id=eq.${encodeURIComponent(safePostId)}`,
    {
      method: "PATCH",
      body: JSON.stringify({ likes_count: likesCount }),
    }
  );

  return {
    likes_count: likesCount,
    post: Array.isArray(updated) ? updated[0] : null,
  };
}

export async function listAffiliateFeedPosts(affiliateId, query = {}) {
  const safeAffiliateId = assertUuid(affiliateId, "Afiliado");
  const limit = limitNumber(query.limit, 30, 1, 60);

  const approvedPosts = await supabaseRequest(
    `/affiliate_feed_posts?status=eq.approved&select=${PUBLIC_POST_SELECT}&order=is_pinned.desc,created_at.desc&limit=${limit}`
  );

  const ownPendingPosts = await supabaseRequest(
    `/affiliate_feed_posts?affiliate_id=eq.${encodeURIComponent(
      safeAffiliateId
    )}&status=in.(pending,rejected,banned)&select=${PUBLIC_POST_SELECT}&order=created_at.desc&limit=10`
  );

  const merged = new Map();

  [...(Array.isArray(ownPendingPosts) ? ownPendingPosts : []), ...(Array.isArray(approvedPosts) ? approvedPosts : [])].forEach((post) => {
    if (post?.id) merged.set(String(post.id), post);
  });

  const posts = Array.from(merged.values()).sort((a, b) => {
    if (Boolean(a.is_pinned) !== Boolean(b.is_pinned)) return a.is_pinned ? -1 : 1;
    return new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime();
  });

  const viewerLikes = await hydrateViewerLikes(posts, safeAffiliateId);

  return Promise.all(posts.map((post) => normalizePost(post, viewerLikes)));
}

export async function createAffiliateFeedPost(affiliate = {}, payload = {}) {
  const affiliateId = assertUuid(affiliate.id || affiliate.affiliate_id, "Afiliado");
  const content = sanitizeContent(payload.content || payload.text || payload.message);
  const uploadedImage = await uploadFeedImage({ affiliateId, imagePayload: payload });

  const insertPayload = {
    affiliate_id: affiliateId,
    affiliate_name: getAffiliateDisplayName(affiliate),
    affiliate_avatar_url: getSafeAvatarUrl(affiliate.profile_photo_url),
    post_type: sanitizePostType(payload.post_type || payload.type),
    content,
    image_path: uploadedImage?.path || null,
    image_url: null,
    status: "pending",
    is_pinned: false,
    is_official: false,
    metadata: {
      source: "affiliate_panel",
      ...(uploadedImage?.metadata || {}),
    },
  };

  const inserted = await supabaseRequest("/affiliate_feed_posts", {
    method: "POST",
    body: JSON.stringify(insertPayload),
  });

  return normalizePost(Array.isArray(inserted) ? inserted[0] : inserted);
}

export async function toggleAffiliateFeedLike(affiliateId, postId, shouldLike = true) {
  const safeAffiliateId = assertUuid(affiliateId, "Afiliado");
  const safePostId = assertUuid(postId, "Post");

  const posts = await supabaseRequest(
    `/affiliate_feed_posts?id=eq.${encodeURIComponent(safePostId)}&status=eq.approved&select=id&limit=1`
  );

  if (!Array.isArray(posts) || !posts.length) {
    const error = new Error("Post não encontrado ou ainda não aprovado.");
    error.statusCode = 404;
    throw error;
  }

  const existing = await supabaseRequest(
    `/affiliate_feed_likes?post_id=eq.${encodeURIComponent(safePostId)}&affiliate_id=eq.${encodeURIComponent(safeAffiliateId)}&select=id&limit=1`
  );

  const existingLike = Array.isArray(existing) ? existing[0] : null;

  if (shouldLike && !existingLike) {
    await supabaseRequest("/affiliate_feed_likes", {
      method: "POST",
      body: JSON.stringify({ post_id: safePostId, affiliate_id: safeAffiliateId }),
    });
  }

  if (!shouldLike && existingLike?.id) {
    await supabaseRequest(`/affiliate_feed_likes?id=eq.${encodeURIComponent(existingLike.id)}`, {
      method: "DELETE",
      headers: {
        Prefer: "return=minimal",
      },
    });
  }

  const result = await refreshPostLikesCount(safePostId);

  return {
    post_id: safePostId,
    liked: shouldLike,
    likes_count: result.likes_count,
  };
}

export async function listAdminAffiliateFeedPosts(query = {}) {
  const status = cleanText(query.status || "").toLowerCase();
  const limit = limitNumber(query.limit, 60, 1, 120);
  const filters = [`select=${ADMIN_POST_SELECT}`];

  if (status && ALLOWED_STATUS.has(status)) {
    filters.push(`status=eq.${encodeURIComponent(status)}`);
  }

  filters.push("order=is_pinned.desc,created_at.desc");
  filters.push(`limit=${limit}`);

  const posts = await supabaseRequest(`/affiliate_feed_posts?${filters.join("&")}`);

  return Promise.all(
    (Array.isArray(posts) ? posts : []).map((post) =>
      normalizePost(post, new Set(), {
        includeInternalFields: true,
        includeModerationFields: true,
      })
    )
  );
}

export async function updateAdminAffiliateFeedPostStatus(postId, payload = {}, admin = {}) {
  const safePostId = assertUuid(postId, "Post");
  const status = sanitizeStatus(payload.status, "pending");
  const now = new Date().toISOString();
  const moderationReason = sanitizeModerationReason(
    payload.rejected_reason || payload.reason || payload.moderation_reason || ""
  );
  const updatePayload = {
    status,
    metadata: {
      moderation_action: status,
      moderated_at: now,
      moderated_by: isUuid(admin?.id) ? admin.id : null,
    },
  };

  if (status === "approved") {
    updatePayload.approved_at = now;
    updatePayload.approved_by = isUuid(admin?.id) ? admin.id : null;
    updatePayload.rejected_reason = null;
  }

  if (status === "pending") {
    updatePayload.approved_at = null;
    updatePayload.approved_by = null;
    updatePayload.rejected_reason = null;
  }

  if (status === "rejected") {
    updatePayload.rejected_reason = moderationReason || "Publicação recusada pela moderação.";
  }

  if (status === "hidden") {
    updatePayload.rejected_reason = moderationReason || "Publicação ocultada pela moderação.";
  }

  if (status === "banned") {
    updatePayload.is_pinned = false;
    updatePayload.rejected_reason = moderationReason || "Publicação banida por violar as regras da comunidade.";
  }

  const updated = await supabaseRequest(
    `/affiliate_feed_posts?id=eq.${encodeURIComponent(safePostId)}`,
    {
      method: "PATCH",
      body: JSON.stringify(updatePayload),
    }
  );

  const post = Array.isArray(updated) ? updated[0] : null;

  if (!post) {
    const error = new Error("Post não encontrado.");
    error.statusCode = 404;
    throw error;
  }

  return normalizePost(post, new Set(), {
    includeInternalFields: true,
    includeModerationFields: true,
  });
}

export async function updateAdminAffiliateFeedPostPin(postId, payload = {}) {
  const safePostId = assertUuid(postId, "Post");
  const isPinned = payload.is_pinned === true || payload.isPinned === true || payload.pinned === true;

  const updated = await supabaseRequest(
    `/affiliate_feed_posts?id=eq.${encodeURIComponent(safePostId)}&status=eq.approved`,
    {
      method: "PATCH",
      body: JSON.stringify({ is_pinned: isPinned }),
    }
  );

  const post = Array.isArray(updated) ? updated[0] : null;

  if (!post) {
    const error = new Error("Só é possível fixar publicação aprovada.");
    error.statusCode = 409;
    throw error;
  }

  return normalizePost(post, new Set(), {
    includeInternalFields: true,
    includeModerationFields: true,
  });
}
