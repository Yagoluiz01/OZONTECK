import express from "express";
import rateLimit from "express-rate-limit";
import { supabaseAdmin } from "../config/supabase.js";
import { calculateProductScore } from "../services/productRanking.service.js";
import {
  buildIntentProfile,
  INTENT_SIGNAL_EVENT_TYPES,
  getIntelligenceLearningStartAt,
} from "../intelligence/intent.engine.js";
import {
  buildPersonalizedRanking,
  buildProductPerformance,
  RECOMMENDATION_PRODUCT_EVENT_TYPES,
} from "../intelligence/recommendation.engine.js";
import { buildLeadScore } from "../intelligence/leadScore.engine.js";

const router = express.Router();

const intentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Muitas consultas de inteligência. Tente novamente em alguns minutos.",
  },
});

const CATALOG_CACHE_TTL_MS = 90 * 1000;
const PERFORMANCE_CACHE_TTL_MS = 3 * 60 * 1000;
const PERFORMANCE_WINDOW_DAYS = 14;

let catalogCache = { expiresAt: 0, rows: [] };
let performanceCache = { expiresAt: 0, data: new Map(), eventsSampled: 0 };

function normalizeId(value, maxLength = 180) {
  const text = String(value || "").trim();
  if (!text) return null;
  return text.slice(0, maxLength);
}

function clampInt(value, min, max, fallback) {
  const number = Math.trunc(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

async function validateVisitorSession(visitorId, sessionId) {
  const { data: sessionRow, error: sessionError } = await supabaseAdmin
    .from("lead_sessions")
    .select("id")
    .eq("session_id", sessionId)
    .eq("visitor_id", visitorId)
    .maybeSingle();

  if (sessionError) throw sessionError;
  return Boolean(sessionRow?.id);
}

function getIntentDateFrom() {
  const learningStartAt = getIntelligenceLearningStartAt();
  const rollingDateFrom = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const parsedLearning = Date.parse(learningStartAt);
  const parsedRolling = Date.parse(rollingDateFrom);
  const dateFrom = new Date(Math.max(parsedRolling, parsedLearning)).toISOString();
  return { learningStartAt, dateFrom };
}

async function loadIntentProfile(visitorId, sessionId) {
  const { learningStartAt, dateFrom } = getIntentDateFrom();
  const { data, error } = await supabaseAdmin
    .from("lead_events")
    .select("session_id,visitor_id,event_type,page,section,created_at")
    .eq("visitor_id", visitorId)
    .in("event_type", INTENT_SIGNAL_EVENT_TYPES)
    .gte("created_at", dateFrom)
    .order("created_at", { ascending: true })
    .limit(1500);

  if (error) throw error;

  return buildIntentProfile(data || [], {
    currentSessionId: sessionId,
    learningStartAt,
  });
}

async function loadRecommendationCatalog() {
  const now = Date.now();
  if (catalogCache.rows.length && catalogCache.expiresAt > now) {
    return catalogCache.rows;
  }

  const { data, error } = await supabaseAdmin
    .from("products")
    .select("*")
    .limit(500);

  if (error) throw error;

  catalogCache = {
    rows: Array.isArray(data) ? data : [],
    expiresAt: now + CATALOG_CACHE_TTL_MS,
  };
  return catalogCache.rows;
}

async function loadProductPerformance(catalogRows) {
  const now = Date.now();
  if (performanceCache.expiresAt > now) return performanceCache;

  const { learningStartAt } = getIntentDateFrom();
  const rollingStart = Date.now() - PERFORMANCE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const dateFrom = new Date(Math.max(rollingStart, Date.parse(learningStartAt))).toISOString();

  const { data, error } = await supabaseAdmin
    .from("lead_events")
    .select("session_id,visitor_id,event_type,section,created_at")
    .in("event_type", RECOMMENDATION_PRODUCT_EVENT_TYPES)
    .gte("created_at", dateFrom)
    .order("created_at", { ascending: false })
    .limit(5000);

  if (error) throw error;

  const events = Array.isArray(data) ? data : [];
  performanceCache = {
    data: buildProductPerformance(events, catalogRows),
    eventsSampled: events.length,
    expiresAt: now + PERFORMANCE_CACHE_TTL_MS,
  };
  return performanceCache;
}

router.post("/intent", intentLimiter, async (req, res) => {
  try {
    const visitorId = normalizeId(req.body?.visitor_id || req.body?.visitorId);
    const sessionId = normalizeId(req.body?.session_id || req.body?.sessionId);

    if (!visitorId || !sessionId) {
      return res.status(400).json({
        success: false,
        message: "visitor_id e session_id são obrigatórios.",
      });
    }

    let validSession = false;
    try {
      validSession = await validateVisitorSession(visitorId, sessionId);
    } catch (sessionError) {
      console.error("STORE INTELLIGENCE SESSION VALIDATION ERROR:", sessionError);
      return res.status(500).json({
        success: false,
        message: "Não foi possível validar a sessão agora.",
      });
    }

    if (!validSession) {
      return res.status(404).json({
        success: false,
        message: "Sessão de inteligência ainda não disponível.",
      });
    }

    let profile;
    try {
      profile = await loadIntentProfile(visitorId, sessionId);
    } catch (error) {
      console.error("STORE INTELLIGENCE INTENT ERROR:", error);
      return res.status(500).json({
        success: false,
        message: "Não foi possível calcular a intenção agora.",
      });
    }

    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    return res.status(200).json({
      success: true,
      data: profile,
    });
  } catch (error) {
    console.error("STORE INTELLIGENCE INTENT INTERNAL ERROR:", error);
    return res.status(500).json({
      success: false,
      message: "Erro interno ao calcular intenção.",
    });
  }
});


router.post("/lead-score", intentLimiter, async (req, res) => {
  try {
    const visitorId = normalizeId(req.body?.visitor_id || req.body?.visitorId);
    const sessionId = normalizeId(req.body?.session_id || req.body?.sessionId);

    if (!visitorId || !sessionId) {
      return res.status(400).json({
        success: false,
        message: "visitor_id e session_id são obrigatórios.",
      });
    }

    const validSession = await validateVisitorSession(visitorId, sessionId);
    if (!validSession) {
      return res.status(404).json({
        success: false,
        message: "Sessão de inteligência ainda não disponível.",
      });
    }

    const profile = await loadIntentProfile(visitorId, sessionId);
    const leadScore = buildLeadScore(profile);

    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    return res.status(200).json({
      success: true,
      data: leadScore,
    });
  } catch (error) {
    console.error("STORE INTELLIGENCE LEAD SCORE ERROR:", error);
    return res.status(500).json({
      success: false,
      message: "Não foi possível calcular o lead score agora.",
    });
  }
});

router.post("/recommendations", intentLimiter, async (req, res) => {
  try {
    const visitorId = normalizeId(req.body?.visitor_id || req.body?.visitorId);
    const sessionId = normalizeId(req.body?.session_id || req.body?.sessionId);
    const excludeProductId = normalizeId(
      req.body?.exclude_product_id || req.body?.excludeProductId,
      180
    );
    const limit = clampInt(req.body?.limit, 1, 12, 8);

    if (!visitorId || !sessionId) {
      return res.status(400).json({
        success: false,
        message: "visitor_id e session_id são obrigatórios.",
      });
    }

    const validSession = await validateVisitorSession(visitorId, sessionId);
    if (!validSession) {
      return res.status(404).json({
        success: false,
        message: "Sessão de inteligência ainda não disponível.",
      });
    }

    const [profile, catalogRows] = await Promise.all([
      loadIntentProfile(visitorId, sessionId),
      loadRecommendationCatalog(),
    ]);

    const productPerformance = await loadProductPerformance(catalogRows);
    const ranking = buildPersonalizedRanking({
      profile,
      products: catalogRows,
      performanceByProduct: productPerformance.data,
      commercialScoreFn: (product) => calculateProductScore(product, { context: "home" }),
      excludeProductId: excludeProductId || "",
      limit,
    });

    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    return res.status(200).json({
      success: true,
      data: {
        ...ranking,
        performance_window_days: PERFORMANCE_WINDOW_DAYS,
        performance_events_sampled: productPerformance.eventsSampled,
        generated_at: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error("STORE INTELLIGENCE RECOMMENDATIONS ERROR:", error);
    return res.status(500).json({
      success: false,
      message: "Não foi possível calcular recomendações agora.",
    });
  }
});

export default router;
