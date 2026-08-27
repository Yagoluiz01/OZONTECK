import { supabaseAdmin } from "../config/supabase.js";
import {
  buildIntentProfile,
  getIntelligenceLearningStartAt,
  INTENT_SIGNAL_EVENT_TYPES,
} from "../intelligence/intent.engine.js";
import { normalizeInterestCategory } from "../intelligence/interestTaxonomy.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const QUALIFYING_INTEREST_EVENT_TYPES = Object.freeze([
  "product_detail_view",
  "add_to_cart",
  "product_add_confirmed",
  "buy_now_confirmed",
]);

const QUALIFYING_INTEREST_EVENT_SET = new Set(QUALIFYING_INTEREST_EVENT_TYPES);

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round(value, decimals = 2) {
  const power = 10 ** decimals;
  return Math.round((Number(value) || 0) * power) / power;
}

function cleanIdentifier(value, maxLength = 180) {
  const text = String(value || "").trim();
  return text ? text.slice(0, maxLength) : "";
}

function safeMetadata(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value || ""));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function eventTimeMs(row) {
  const parsed = Date.parse(String(row?.created_at || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function categoryFromEvent(row = {}) {
  const metadata = safeMetadata(row.section);
  return {
    key: normalizeInterestCategory(
      metadata.category || metadata.category_name || metadata.categoryName
    ),
    label: cleanIdentifier(
      metadata.category || metadata.category_name || metadata.categoryName,
      120
    ),
  };
}

function getEffectiveDateFrom({ lookbackDays = 30, nowMs = Date.now() } = {}) {
  const learningStartAt = getIntelligenceLearningStartAt();
  const learningStartMs = Date.parse(learningStartAt);
  const rollingStartMs = nowMs - Math.max(1, Number(lookbackDays) || 30) * DAY_MS;

  return {
    learningStartAt,
    dateFrom: new Date(Math.max(rollingStartMs, learningStartMs)).toISOString(),
  };
}

export function calculateInterestRecencyScore(
  lastSignalAt,
  { nowMs = Date.now(), halfLifeHours = 72 } = {}
) {
  const signalMs = Date.parse(String(lastSignalAt || ""));
  if (!Number.isFinite(signalMs)) return 0;

  const ageHours = Math.max(0, (Number(nowMs) - signalMs) / HOUR_MS);
  const safeHalfLife = Math.max(1, Number(halfLifeHours) || 72);
  return round(clamp(100 * 0.5 ** (ageHours / safeHalfLife), 0, 100), 2);
}

export function calculateInterestMatchScore(
  { categoryScore = 0, confidence = 0, lastSignalAt = null } = {},
  options = {}
) {
  const recencyScore = calculateInterestRecencyScore(lastSignalAt, options);
  const matchScore =
    clamp(Number(categoryScore) || 0, 0, 100) * 0.6 +
    clamp(Number(confidence) || 0, 0, 100) * 0.25 +
    recencyScore * 0.15;

  return {
    matchScore: round(clamp(matchScore, 0, 100), 2),
    recencyScore,
  };
}

export function evaluateInterestEligibility(profile = {}, config = {}, nowMs = Date.now()) {
  const categoryScore = Number(profile.category_score ?? profile.categoryScore ?? 0);
  const confidence = Number(profile.confidence || 0);
  const qualifyingSignals = Number(
    profile.qualifying_signal_count ?? profile.qualifyingSignalCount ?? 0
  );
  const lookbackDays = Math.max(1, Number(config.lookbackDays ?? 30));
  const lastSignalMs = Date.parse(String(profile.last_signal_at || profile.lastSignalAt || ""));
  const recentEnough =
    Number.isFinite(lastSignalMs) && lastSignalMs >= nowMs - lookbackDays * DAY_MS;
  const { matchScore, recencyScore } = calculateInterestMatchScore(
    {
      categoryScore,
      confidence,
      lastSignalAt: profile.last_signal_at || profile.lastSignalAt,
    },
    {
      nowMs,
      halfLifeHours: config.halfLifeHours ?? 72,
    }
  );

  const reasons = [];
  if (categoryScore < Number(config.minCategoryScore ?? 35)) reasons.push("category_score_low");
  if (confidence < Number(config.minConfidence ?? 30)) reasons.push("confidence_low");
  if (qualifyingSignals < Math.max(1, Number(config.minQualifyingSignals ?? 1))) {
    reasons.push("qualifying_signals_missing");
  }
  if (!recentEnough) reasons.push("interest_expired");
  if (matchScore < Number(config.minMatchScore ?? 55)) reasons.push("match_score_low");

  return {
    eligible: reasons.length === 0,
    matchScore,
    recencyScore,
    reasons,
  };
}

/**
 * Converte a saída do intent-v1.2 em uma projeção indexável por categoria.
 * O cálculo continua sendo feito pelo motor existente; esta função só o projeta.
 */
export function buildCustomerInterestProfileRows(
  events = [],
  { customerId, nowMs = Date.now(), learningStartAt = getIntelligenceLearningStartAt() } = {}
) {
  const source = Array.isArray(events) ? events : [];
  const sorted = source.slice().sort((a, b) => eventTimeMs(a) - eventTimeMs(b));
  const mostRecent = sorted[sorted.length - 1];
  const intent = buildIntentProfile(sorted, {
    currentSessionId: mostRecent?.session_id || null,
    learningStartAt,
    nowMs,
  });

  const categorySignals = new Map();
  for (const event of sorted) {
    const category = categoryFromEvent(event);
    if (!category.key) continue;

    const current = categorySignals.get(category.key) || {
      label: category.label || category.key,
      qualifyingSignals: 0,
      lastSignalAt: null,
    };
    if (category.label) current.label = category.label;
    if (QUALIFYING_INTEREST_EVENT_SET.has(String(event?.event_type || ""))) {
      current.qualifyingSignals += 1;
    }
    if (!current.lastSignalAt || eventTimeMs(event) >= Date.parse(current.lastSignalAt)) {
      current.lastSignalAt = event.created_at || current.lastSignalAt;
    }
    categorySignals.set(category.key, current);
  }

  const projected = new Map();
  for (const category of Array.isArray(intent.top_categories) ? intent.top_categories : []) {
    const categoryKey = normalizeInterestCategory(category.name || category.key);
    if (!categoryKey) continue;

    const signals = categorySignals.get(categoryKey) || {};
    const current = projected.get(categoryKey);
    const candidate = {
      customer_id: customerId,
      category_key: categoryKey,
      category_label: signals.label || category.name || category.key || categoryKey,
      category_score: clamp(Number(category.score) || 0, 0, 100),
      confidence: clamp(Number(intent.confidence) || 0, 0, 100),
      qualifying_signal_count: Number(signals.qualifyingSignals || 0),
      signal_counts: intent.effective_signal_counts || {},
      last_signal_at: signals.lastSignalAt || intent.last_signal_at || null,
      profile_version: intent.version || "intent-v1.2",
      calculated_at: new Date(nowMs).toISOString(),
      updated_at: new Date(nowMs).toISOString(),
    };

    if (!current || candidate.category_score > current.category_score) {
      projected.set(categoryKey, candidate);
    } else {
      current.qualifying_signal_count = Math.max(
        current.qualifying_signal_count,
        candidate.qualifying_signal_count
      );
      if (Date.parse(candidate.last_signal_at || "") > Date.parse(current.last_signal_at || "")) {
        current.last_signal_at = candidate.last_signal_at;
      }
    }
  }

  return {
    intent,
    rows: Array.from(projected.values()),
  };
}

export function buildVisitorInterestProfileRows(
  events = [],
  { visitorId, nowMs = Date.now(), learningStartAt = getIntelligenceLearningStartAt() } = {}
) {
  const safeVisitorId = cleanIdentifier(visitorId);
  if (!safeVisitorId) {
    throw new Error("visitorId inválido para projeção do perfil de interesse.");
  }

  const projection = buildCustomerInterestProfileRows(events, {
    customerId: null,
    nowMs,
    learningStartAt,
  });

  return {
    intent: projection.intent,
    rows: projection.rows.map(({ customer_id: _customerId, ...row }) => ({
      ...row,
      visitor_id: safeVisitorId,
    })),
  };
}

export async function verifyVisitorSession(
  { visitorId, sessionId } = {},
  { client = supabaseAdmin } = {}
) {
  const safeVisitorId = cleanIdentifier(visitorId);
  const safeSessionId = cleanIdentifier(sessionId);
  if (!safeVisitorId || !safeSessionId) return false;

  const { data, error } = await client
    .from("lead_sessions")
    .select("id")
    .eq("visitor_id", safeVisitorId)
    .eq("session_id", safeSessionId)
    .maybeSingle();

  if (error) throw error;
  return Boolean(data?.id);
}

export async function linkCustomerVisitor(
  { customerId, visitorId, sessionId, source = "authenticated_store" } = {},
  { client = supabaseAdmin } = {}
) {
  const safeCustomerId = cleanIdentifier(customerId, 80);
  const safeVisitorId = cleanIdentifier(visitorId);
  const safeSessionId = cleanIdentifier(sessionId);

  if (!UUID_PATTERN.test(safeCustomerId) || !safeVisitorId || !safeSessionId) {
    const error = new Error("Identificadores de cliente e navegação inválidos.");
    error.statusCode = 400;
    error.code = "invalid_identity_link";
    throw error;
  }

  const sessionIsValid = await verifyVisitorSession(
    { visitorId: safeVisitorId, sessionId: safeSessionId },
    { client }
  );
  if (!sessionIsValid) {
    const error = new Error("A sessão de navegação não pertence ao visitante informado.");
    error.statusCode = 400;
    error.code = "visitor_session_mismatch";
    throw error;
  }

  const now = new Date().toISOString();
  const { data, error } = await client
    .from("customer_visitor_links")
    .upsert(
      {
        customer_id: safeCustomerId,
        visitor_id: safeVisitorId,
        last_session_id: safeSessionId,
        source: cleanIdentifier(source, 60) || "authenticated_store",
        is_verified: true,
        last_seen_at: now,
        updated_at: now,
      },
      { onConflict: "visitor_id" }
    )
    .select("id,customer_id,visitor_id,last_seen_at")
    .single();

  if (error) throw error;
  return data;
}

export async function refreshCustomerInterestProfile(
  customerId,
  { client = supabaseAdmin, lookbackDays = 30, nowMs = Date.now() } = {}
) {
  const safeCustomerId = cleanIdentifier(customerId, 80);
  if (!UUID_PATTERN.test(safeCustomerId)) {
    throw new Error("customerId inválido para atualização do perfil de interesse.");
  }

  const { data: links, error: linksError } = await client
    .from("customer_visitor_links")
    .select("visitor_id")
    .eq("customer_id", safeCustomerId)
    .eq("is_verified", true)
    .order("last_seen_at", { ascending: false })
    .limit(20);
  if (linksError) throw linksError;

  const visitorIds = Array.from(
    new Set((links || []).map((row) => cleanIdentifier(row.visitor_id)).filter(Boolean))
  );
  const now = new Date(nowMs).toISOString();
  if (!visitorIds.length) return { customerId: safeCustomerId, categories: 0, events: 0 };

  const { learningStartAt, dateFrom } = getEffectiveDateFrom({ lookbackDays, nowMs });
  const { data: events, error: eventsError } = await client
    .from("lead_events")
    .select("session_id,visitor_id,event_type,page,section,created_at")
    .in("visitor_id", visitorIds)
    .in("event_type", INTENT_SIGNAL_EVENT_TYPES)
    .gte("created_at", dateFrom)
    .order("created_at", { ascending: false })
    .limit(5000);
  if (eventsError) throw eventsError;

  const projection = buildCustomerInterestProfileRows(events || [], {
    customerId: safeCustomerId,
    nowMs,
    learningStartAt,
  });

  if (projection.rows.length) {
    const { error: upsertError } = await client
      .from("customer_interest_profiles")
      .upsert(projection.rows, { onConflict: "customer_id,category_key" });
    if (upsertError) throw upsertError;
  }

  const { data: existing, error: existingError } = await client
    .from("customer_interest_profiles")
    .select("category_key")
    .eq("customer_id", safeCustomerId);
  if (existingError) throw existingError;

  const currentKeys = new Set(projection.rows.map((row) => row.category_key));
  const staleKeys = (existing || [])
    .map((row) => row.category_key)
    .filter((key) => key && !currentKeys.has(key));
  if (staleKeys.length) {
    const { error: deleteError } = await client
      .from("customer_interest_profiles")
      .delete()
      .eq("customer_id", safeCustomerId)
      .in("category_key", staleKeys);
    if (deleteError) throw deleteError;
  }

  const { error: touchError } = await client
    .from("customer_visitor_links")
    .update({ profile_refreshed_at: now, updated_at: now })
    .eq("customer_id", safeCustomerId)
    .eq("is_verified", true);
  if (touchError) throw touchError;

  return {
    customerId: safeCustomerId,
    categories: projection.rows.length,
    events: Array.isArray(events) ? events.length : 0,
    confidence: projection.intent.confidence,
    profileVersion: projection.intent.version,
  };
}

export async function refreshVisitorInterestProfile(
  visitorId,
  { client = supabaseAdmin, lookbackDays = 30, nowMs = Date.now() } = {}
) {
  const safeVisitorId = cleanIdentifier(visitorId);
  if (!safeVisitorId) {
    throw new Error("visitorId inválido para atualização do perfil de interesse.");
  }

  const { learningStartAt, dateFrom } = getEffectiveDateFrom({ lookbackDays, nowMs });
  const { data: events, error: eventsError } = await client
    .from("lead_events")
    .select("session_id,visitor_id,event_type,page,section,created_at")
    .eq("visitor_id", safeVisitorId)
    .in("event_type", INTENT_SIGNAL_EVENT_TYPES)
    .gte("created_at", dateFrom)
    .order("created_at", { ascending: false })
    .limit(5000);
  if (eventsError) throw eventsError;

  const projection = buildVisitorInterestProfileRows(events || [], {
    visitorId: safeVisitorId,
    nowMs,
    learningStartAt,
  });

  if (projection.rows.length) {
    const { error: upsertError } = await client
      .from("visitor_interest_profiles")
      .upsert(projection.rows, { onConflict: "visitor_id,category_key" });
    if (upsertError) throw upsertError;
  }

  const { data: existing, error: existingError } = await client
    .from("visitor_interest_profiles")
    .select("category_key")
    .eq("visitor_id", safeVisitorId);
  if (existingError) throw existingError;

  const currentKeys = new Set(projection.rows.map((row) => row.category_key));
  const staleKeys = (existing || [])
    .map((row) => row.category_key)
    .filter((key) => key && !currentKeys.has(key));
  if (staleKeys.length) {
    const { error: deleteError } = await client
      .from("visitor_interest_profiles")
      .delete()
      .eq("visitor_id", safeVisitorId)
      .in("category_key", staleKeys);
    if (deleteError) throw deleteError;
  }

  const now = new Date(nowMs).toISOString();
  const { error: touchError } = await client
    .from("customer_marketing_push_subscriptions")
    .update({ profile_refreshed_at: now, updated_at: now })
    .eq("visitor_id", safeVisitorId)
    .eq("is_active", true);
  if (touchError) throw touchError;

  return {
    visitorId: safeVisitorId,
    categories: projection.rows.length,
    events: Array.isArray(events) ? events.length : 0,
    confidence: projection.intent.confidence,
    profileVersion: projection.intent.version,
  };
}

export async function refreshCustomerInterestProfilesBatch(
  {
    limit = 25,
    minRefreshMinutes = 30,
    lookbackDays = 30,
    nowMs = Date.now(),
  } = {},
  { client = supabaseAdmin } = {}
) {
  const safeLimit = clamp(Math.trunc(Number(limit) || 25), 1, 100);
  const cutoff = new Date(
    nowMs - Math.max(1, Number(minRefreshMinutes) || 30) * 60 * 1000
  ).toISOString();

  const { data: links, error } = await client
    .from("customer_visitor_links")
    .select("customer_id,last_seen_at,profile_refreshed_at")
    .eq("is_verified", true)
    .or(`profile_refreshed_at.is.null,profile_refreshed_at.lt.${cutoff}`)
    .order("last_seen_at", { ascending: false })
    .limit(safeLimit * 3);
  if (error) throw error;

  const customerIds = Array.from(
    new Set((links || []).map((row) => row.customer_id).filter(Boolean))
  ).slice(0, safeLimit);

  const result = { checked: customerIds.length, refreshed: 0, failed: 0, failures: [] };
  for (const customerId of customerIds) {
    try {
      await refreshCustomerInterestProfile(customerId, {
        client,
        lookbackDays,
        nowMs,
      });
      result.refreshed += 1;
    } catch (refreshError) {
      result.failed += 1;
      result.failures.push({
        customerId,
        code: refreshError?.code || null,
        message: refreshError?.message || String(refreshError),
      });
    }
  }

  return result;
}

export async function refreshVisitorInterestProfilesBatch(
  {
    limit = 25,
    minRefreshMinutes = 30,
    lookbackDays = 30,
    nowMs = Date.now(),
  } = {},
  { client = supabaseAdmin } = {}
) {
  const safeLimit = clamp(Math.trunc(Number(limit) || 25), 1, 100);
  const cutoff = new Date(
    nowMs - Math.max(1, Number(minRefreshMinutes) || 30) * 60 * 1000
  ).toISOString();

  let subscriptionsQuery = client
    .from("customer_marketing_push_subscriptions")
    .select("customer_id,visitor_id,last_seen_at,profile_refreshed_at")
    .eq("is_active", true);
  if (typeof subscriptionsQuery.is === "function") {
    subscriptionsQuery = subscriptionsQuery.is("customer_id", null);
  }
  if (typeof subscriptionsQuery.not === "function") {
    subscriptionsQuery = subscriptionsQuery.not("visitor_id", "is", null);
  }
  const { data: subscriptions, error } = await subscriptionsQuery
    .or(`profile_refreshed_at.is.null,profile_refreshed_at.lt.${cutoff}`)
    .order("last_seen_at", { ascending: false })
    .limit(safeLimit * 3);
  if (error) throw error;

  const visitorIds = Array.from(
    new Set(
      (subscriptions || [])
        .filter((row) => !row?.customer_id)
        .map((row) => cleanIdentifier(row?.visitor_id))
        .filter(Boolean)
    )
  ).slice(0, safeLimit);

  const result = { checked: visitorIds.length, refreshed: 0, failed: 0, failures: [] };
  for (const currentVisitorId of visitorIds) {
    try {
      await refreshVisitorInterestProfile(currentVisitorId, {
        client,
        lookbackDays,
        nowMs,
      });
      result.refreshed += 1;
    } catch (refreshError) {
      result.failed += 1;
      result.failures.push({
        visitorId: currentVisitorId,
        code: refreshError?.code || null,
        message: refreshError?.message || String(refreshError),
      });
    }
  }

  return result;
}
