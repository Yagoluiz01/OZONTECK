import { env } from "../config/env.js";
import { getAffiliateSummary } from "./affiliatePortal.service.js";

const SUPABASE_URL = String(env.supabaseUrl || "").replace(/\/+$/, "");
const SERVICE_ROLE_KEY = env.supabaseServiceRoleKey;

function assertSupabaseConfig() {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    const error = new Error("Configuração do Supabase ausente para a comunidade de conquistas.");
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

async function supabaseRequest(endpoint, options = {}) {
  assertSupabaseConfig();

  const method = String(options.method || "GET").toUpperCase();
  const headers = getHeaders(options.headers || {});

  if (["POST", "PUT", "PATCH", "DELETE"].includes(method) && !headers.Prefer) {
    headers.Prefer = "return=representation";
  }

  const response = await fetch(`${SUPABASE_URL}/rest/v1${endpoint}`, {
    ...options,
    method,
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
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
      `Erro Supabase comunidade: ${response.status}`;

    const error = new Error(message);
    error.statusCode = response.status;
    error.details = data;
    throw error;
  }

  return data;
}

function cleanText(value) {
  return String(value || "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim();
}

function normalizeMoney(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? Math.max(0, Number(number.toFixed(2))) : 0;
}

function normalizeInteger(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? Math.max(0, Math.round(number)) : 0;
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

function getAffiliateIdFromSummary(summaryResult = {}, fallback = "") {
  const affiliate = summaryResult.affiliate || summaryResult.profile || summaryResult.user || {};
  const levelGoal = summaryResult.level_goal || summaryResult.goal || {};
  const candidates = [
    affiliate.id,
    affiliate.affiliate_id,
    summaryResult.affiliate_id,
    levelGoal.affiliate_id,
    fallback,
  ];

  for (const candidate of candidates) {
    if (isUuid(candidate)) return String(candidate);
  }

  return "";
}

function ensureAffiliateIdOnSummary(summaryResult = {}, affiliateId = "") {
  const safeAffiliateId = getAffiliateIdFromSummary(summaryResult, affiliateId);

  if (!safeAffiliateId) {
    const error = new Error("Não foi possível identificar o afiliado logado. Entre novamente no painel.");
    error.statusCode = 401;
    throw error;
  }

  summaryResult.affiliate = {
    ...(summaryResult.affiliate || {}),
    id: safeAffiliateId,
  };

  return safeAffiliateId;
}

function normalizeLevelName(value = "") {
  return cleanText(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function shouldPublishLevelAchievement(levelGoal = {}) {
  const levelOrder = Number(levelGoal.current_level_order || 1);
  const levelName = normalizeLevelName(levelGoal.current_level_name || "");

  if (levelOrder > 1) return true;
  if (!levelName) return false;

  return !["iniciante", "nivel inicial", "inicial", "start"].includes(levelName);
}

function getAffiliateName(affiliate = {}) {
  return cleanText(
    affiliate.full_name ||
      affiliate.fullName ||
      affiliate.name ||
      affiliate.affiliate_name ||
      affiliate.email ||
      "Afiliado OZONTECK"
  ).slice(0, 140);
}

function getAffiliateAvatar(affiliate = {}) {
  const value = cleanText(
    affiliate.profile_photo_url ||
      affiliate.profilePhotoUrl ||
      affiliate.avatar_url ||
      affiliate.avatarUrl ||
      affiliate.photo_url ||
      affiliate.photoUrl ||
      affiliate.image_url ||
      affiliate.picture ||
      ""
  );

  if (!value) return null;

  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol)) return null;
    return url.toString().slice(0, 1200);
  } catch {
    return null;
  }
}

async function getAffiliateStorefrontPhoto(affiliateId) {
  try {
    const rows = await supabaseRequest(
      `/affiliate_storefronts?affiliate_id=eq.${encodeURIComponent(
        affiliateId
      )}&select=profile_photo_url&limit=1`
    );

    const row = Array.isArray(rows) ? rows[0] : null;
    return getAffiliateAvatar({ profile_photo_url: row?.profile_photo_url });
  } catch (error) {
    console.warn("AFFILIATE_ACHIEVEMENT_PHOTO_WARN:", {
      affiliateId,
      message: error?.message,
      details: error?.details,
    });
    return null;
  }
}

function buildAchievementPayload(summaryResult = {}, options = {}) {
  const affiliate = summaryResult.affiliate || {};
  const summary = summaryResult.summary || {};
  const levelGoal = summaryResult.level_goal || {};

  const affiliateId = assertUuid(affiliate.id || levelGoal.affiliate_id, "Afiliado");
  const levelOrder = normalizeInteger(levelGoal.current_level_order || 1);
  const levelName = cleanText(levelGoal.current_level_name || "Iniciante").slice(0, 100);
  const affiliateName = getAffiliateName(affiliate);
  const paidConversions = normalizeInteger(
    levelGoal.paid_conversions ||
      summary.total_conversions ||
      summary.total_orders ||
      summary.orders_count ||
      0
  );

  const monthGain = normalizeMoney(
    summary.month_commission ||
      summary.current_month_commission ||
      summary.monthly_commission ||
      summary.released_commission ||
      0
  );

  const totalGain = normalizeMoney(
    summary.total_earned ||
      summary.total_commission ||
      summary.approved_commission ||
      summary.released_balance_gross ||
      summary.total_paid ||
      0
  );

  return {
    affiliate_id: affiliateId,
    affiliate_name: affiliateName,
    affiliate_avatar_url: getAffiliateAvatar(affiliate) || (await getAffiliateStorefrontPhoto(safeAffiliateId)),
    level_order: levelOrder,
    level_name: levelName,
    sales_count: paidConversions,
    month_gain: monthGain,
    total_gain: totalGain,
    headline: `Parabéns, ${affiliateName.split(/\s+/)[0] || "Afiliado"}!`,
    message:
      "Sua dedicação está gerando resultados. Continue evoluindo e inspire outros afiliados a crescer também.",
    is_public: true,
    metadata: {
      source: "affiliate_level_sync",
      level_goal: {
        current_goal: levelGoal.current_goal || null,
        progress_percent: levelGoal.progress_percent || null,
        next_level_name: levelGoal.next_level_name || null,
      },
      summary_refreshed_at: new Date().toISOString(),
    },
  };
}

async function upsertAchievement(payload = {}) {
  const existing = await supabaseRequest(
    `/affiliate_level_achievements?affiliate_id=eq.${encodeURIComponent(
      payload.affiliate_id
    )}&level_order=eq.${encodeURIComponent(payload.level_order)}&select=*&limit=1`
  );

  const existingRow = Array.isArray(existing) ? existing[0] : null;

  if (existingRow?.id) {
    const rows = await supabaseRequest(
      `/affiliate_level_achievements?id=eq.${encodeURIComponent(existingRow.id)}`,
      {
        method: "PATCH",
        body: {
          affiliate_name: payload.affiliate_name,
          affiliate_avatar_url: payload.affiliate_avatar_url,
          level_name: payload.level_name,
          sales_count: payload.sales_count,
          month_gain: payload.month_gain,
          total_gain: payload.total_gain,
          headline: payload.headline,
          message: payload.message,
          is_public: true,
          metadata: {
            ...(existingRow.metadata || {}),
            ...(payload.metadata || {}),
            last_synced_at: new Date().toISOString(),
          },
        },
      }
    );

    return Array.isArray(rows) ? rows[0] : rows;
  }

  const rows = await supabaseRequest("/affiliate_level_achievements", {
    method: "POST",
    body: payload,
  });

  return Array.isArray(rows) ? rows[0] : rows;
}

export async function syncAffiliateLevelAchievement(affiliateId) {
  const summaryResult = await getAffiliateSummary(affiliateId);
  const safeAffiliateId = ensureAffiliateIdOnSummary(summaryResult, affiliateId);
  const levelGoal = summaryResult.level_goal || {};

  if (!shouldPublishLevelAchievement(levelGoal)) {
    return {
      created: false,
      achievement: null,
      summary: summaryResult,
    };
  }

  const affiliate = summaryResult.affiliate || {};
  const avatarUrl = getAffiliateAvatar(affiliate) || (await getAffiliateStorefrontPhoto(safeAffiliateId));
  const payload = buildAchievementPayload(summaryResult, { avatarUrl });
  const achievement = await upsertAchievement(payload);

  return {
    created: Boolean(achievement?.id),
    achievement,
    summary: summaryResult,
  };
}

async function getCongratsByAchievementIds(achievementIds = []) {
  const ids = achievementIds.filter(isUuid);
  if (!ids.length) return [];

  const joined = ids.join(",");
  const rows = await supabaseRequest(
    `/affiliate_level_achievement_congrats?achievement_id=in.(${joined})&select=id,achievement_id,affiliate_id,affiliate_name,affiliate_avatar_url,created_at&order=created_at.desc&limit=1000`
  );

  return Array.isArray(rows) ? rows : [];
}

function mapAchievement(row = {}, congrats = [], viewerAffiliateId = null) {
  const rowCongrats = congrats.filter((item) => String(item.achievement_id) === String(row.id));
  const viewerHasCongratulated = rowCongrats.some(
    (item) => String(item.affiliate_id) === String(viewerAffiliateId)
  );

  return {
    id: row.id,
    affiliate_id: row.affiliate_id,
    affiliate_name: row.affiliate_name || "Afiliado OZONTECK",
    affiliate_avatar_url: row.affiliate_avatar_url || null,
    level_order: normalizeInteger(row.level_order || 0),
    level_name: row.level_name || "Nível",
    sales_count: normalizeInteger(row.sales_count || 0),
    month_gain: normalizeMoney(row.month_gain || 0),
    total_gain: normalizeMoney(row.total_gain || 0),
    headline: row.headline || `Parabéns, ${row.affiliate_name || "Afiliado"}!`,
    message: row.message || "Continue evoluindo e inspirando outros afiliados.",
    is_public: row.is_public !== false,
    created_at: row.created_at,
    updated_at: row.updated_at,
    congrats_count: rowCongrats.length,
    viewer_has_congratulated: viewerHasCongratulated,
    recent_congrats: rowCongrats.slice(0, 4).map((item) => ({
      id: item.id,
      affiliate_name: item.affiliate_name || "Afiliado",
      affiliate_avatar_url: item.affiliate_avatar_url || null,
      created_at: item.created_at,
    })),
  };
}

export async function listAffiliateCommunityAchievements(affiliateId, options = {}) {
  let safeAffiliateId = isUuid(affiliateId) ? String(affiliateId) : "";

  let ownSync = null;
  try {
    ownSync = await syncAffiliateLevelAchievement(safeAffiliateId);
  } catch (error) {
    console.error("AFFILIATE_ACHIEVEMENT_SYNC_WARN:", {
      affiliateId: safeAffiliateId,
      message: error?.message,
      details: error?.details,
    });
  }

  if (ownSync?.summary) {
    safeAffiliateId = getAffiliateIdFromSummary(ownSync.summary, safeAffiliateId);
  }

  const limit = Math.min(Math.max(Number(options.limit || 30), 1), 80);
  const rows = await supabaseRequest(
    `/affiliate_level_achievements?is_public=eq.true&level_order=gte.2&select=*&order=level_order.desc,created_at.desc&limit=${limit}`
  );

  const achievements = Array.isArray(rows) ? rows : [];
  const congrats = await getCongratsByAchievementIds(achievements.map((item) => item.id));

  return {
    affiliate: ownSync?.summary?.affiliate || null,
    achievements: achievements.map((item) => mapAchievement(item, congrats, safeAffiliateId || null)),
    own_achievement: ownSync?.achievement ? mapAchievement(ownSync.achievement, congrats, safeAffiliateId || null) : null,
    synced: Boolean(ownSync?.created),
  };
}

export async function congratulateAchievement(achievementId, affiliateId) {
  const safeAchievementId = assertUuid(achievementId, "Conquista");
  const summaryResult = await getAffiliateSummary(affiliateId);
  const safeAffiliateId = ensureAffiliateIdOnSummary(summaryResult, affiliateId);

  const achievementRows = await supabaseRequest(
    `/affiliate_level_achievements?id=eq.${encodeURIComponent(
      safeAchievementId
    )}&is_public=eq.true&level_order=gte.2&select=*&limit=1`
  );

  const achievement = Array.isArray(achievementRows) ? achievementRows[0] : null;

  if (!achievement?.id) {
    const error = new Error("Conquista não encontrada ou não publicada.");
    error.statusCode = 404;
    throw error;
  }

  const affiliate = summaryResult.affiliate || {};

  const existing = await supabaseRequest(
    `/affiliate_level_achievement_congrats?achievement_id=eq.${encodeURIComponent(
      safeAchievementId
    )}&affiliate_id=eq.${encodeURIComponent(safeAffiliateId)}&select=id&limit=1`
  );

  let congrat = Array.isArray(existing) ? existing[0] : null;

  if (!congrat?.id) {
    const rows = await supabaseRequest("/affiliate_level_achievement_congrats", {
      method: "POST",
      body: {
        achievement_id: safeAchievementId,
        affiliate_id: safeAffiliateId,
        affiliate_name: getAffiliateName(affiliate),
        affiliate_avatar_url: getAffiliateAvatar(affiliate) || (await getAffiliateStorefrontPhoto(safeAffiliateId)),
      },
    });

    congrat = Array.isArray(rows) ? rows[0] : rows;
  }

  const congrats = await getCongratsByAchievementIds([safeAchievementId]);
  const count = congrats.filter((item) => String(item.achievement_id) === String(safeAchievementId)).length;

  return {
    congrat,
    congrats_count: count,
    viewer_has_congratulated: true,
  };
}
