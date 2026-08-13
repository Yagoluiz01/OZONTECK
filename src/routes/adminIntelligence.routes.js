import express from "express";
import { supabaseAdmin } from "../config/supabase.js";
import { requireAdminAuth } from "../middlewares/auth.middleware.js";
import { requireMasterAdmin } from "../middlewares/masterAdmin.middleware.js";
import {
  buildIntentOverview,
  buildIntentProfile,
  INTENT_SIGNAL_EVENT_TYPES,
  getIntelligenceLearningStartAt,
} from "../intelligence/intent.engine.js";
import { buildLeadScore, buildLeadScoreOverview } from "../intelligence/leadScore.engine.js";

const router = express.Router();

function toPositiveInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function normalizeId(value, maxLength = 180) {
  const text = String(value || "").trim();
  if (!text) return null;
  return text.slice(0, maxLength);
}

function normalizeLeadScoreTargets(value, limit = 180) {
  if (!Array.isArray(value)) return [];

  const seen = new Set();
  const normalized = [];

  for (const item of value) {
    const visitorId = normalizeId(item?.visitor_id || item?.visitorId);
    const sessionId = normalizeId(item?.session_id || item?.sessionId);
    if (!visitorId || !sessionId) continue;

    const key = `${visitorId}::${sessionId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({ visitor_id: visitorId, session_id: sessionId });
    if (normalized.length >= limit) break;
  }

  return normalized;
}

function chunk(values = [], size = 40) {
  const rows = [];
  for (let index = 0; index < values.length; index += size) {
    rows.push(values.slice(index, index + size));
  }
  return rows;
}

function intelligenceQueueOrder(row = {}) {
  const priority = { critical: 5, high: 4, medium: 3, low: 2, none: 0 };
  const recovery = row?.recovery_priority || {};
  const eligible = recovery.eligible_by_behavior === true ? 1 : 0;
  const ready = recovery.ready_by_behavior === true ? 1 : 0;
  return (eligible * 100000) + (ready * 50000) + ((priority[recovery.key] || 0) * 10000) + Number(row?.lead_score || 0);
}

router.use(requireAdminAuth, requireMasterAdmin);

router.get("/intent/overview", async (req, res) => {
  try {
    const days = Math.min(toPositiveInt(req.query.days, 7), 30);
    const learningStartAt = getIntelligenceLearningStartAt();
    const requestedDateFrom = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const dateFrom = new Date(Math.max(Date.parse(requestedDateFrom), Date.parse(learningStartAt))).toISOString();

    const { data, error } = await supabaseAdmin
      .from("lead_events")
      .select("session_id,visitor_id,event_type,page,section,created_at")
      .in("event_type", INTENT_SIGNAL_EVENT_TYPES)
      .gte("created_at", dateFrom)
      .order("created_at", { ascending: true })
      .limit(20000);

    if (error) {
      console.error("ADMIN INTELLIGENCE OVERVIEW ERROR:", error);
      return res.status(500).json({
        success: false,
        message: "Não foi possível montar o panorama de intenção.",
      });
    }

    const overview = buildIntentOverview(data || [], { learningStartAt });

    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    return res.status(200).json({
      success: true,
      period: { days, from: dateFrom, to: new Date().toISOString() },
      data: overview,
    });
  } catch (error) {
    console.error("ADMIN INTELLIGENCE OVERVIEW INTERNAL ERROR:", error);
    return res.status(500).json({
      success: false,
      message: "Erro interno ao montar inteligência de intenção.",
    });
  }
});

router.get("/intent/visitor/:visitorId", async (req, res) => {
  try {
    const visitorId = normalizeId(req.params.visitorId);
    const sessionId = normalizeId(req.query.session_id || req.query.sessionId);
    const days = Math.min(toPositiveInt(req.query.days, 30), 90);

    if (!visitorId) {
      return res.status(400).json({ success: false, message: "visitorId inválido." });
    }

    const learningStartAt = getIntelligenceLearningStartAt();
    const requestedDateFrom = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const dateFrom = new Date(Math.max(Date.parse(requestedDateFrom), Date.parse(learningStartAt))).toISOString();

    const { data, error } = await supabaseAdmin
      .from("lead_events")
      .select("session_id,visitor_id,event_type,page,section,created_at")
      .eq("visitor_id", visitorId)
      .in("event_type", INTENT_SIGNAL_EVENT_TYPES)
      .gte("created_at", dateFrom)
      .order("created_at", { ascending: true })
      .limit(2500);

    if (error) {
      console.error("ADMIN INTELLIGENCE VISITOR ERROR:", error);
      return res.status(500).json({
        success: false,
        message: "Não foi possível calcular a intenção deste visitante.",
      });
    }

    const rows = data || [];
    const effectiveSessionId =
      sessionId || rows.slice().reverse().find((row) => row.session_id)?.session_id || null;

    const profile = buildIntentProfile(rows, {
      currentSessionId: effectiveSessionId,
      learningStartAt,
    });

    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    return res.status(200).json({
      success: true,
      visitor_id: visitorId,
      session_id: effectiveSessionId,
      period: { days, from: dateFrom, to: new Date().toISOString() },
      data: profile,
    });
  } catch (error) {
    console.error("ADMIN INTELLIGENCE VISITOR INTERNAL ERROR:", error);
    return res.status(500).json({
      success: false,
      message: "Erro interno ao calcular intenção do visitante.",
    });
  }
});



router.post("/lead-score/batch", async (req, res) => {
  try {
    const targets = normalizeLeadScoreTargets(req.body?.leads || req.body?.targets);
    const days = Math.min(toPositiveInt(req.body?.days || req.query?.days, 30), 90);

    if (!targets.length) {
      res.setHeader("Cache-Control", "private, no-store, max-age=0");
      return res.status(200).json({
        success: true,
        data: {
          version: "lead-score-v3.1.3-observer",
          mode: "observation",
          leads: [],
          requested: 0,
          scored: 0,
          price_affinity_used: false,
        },
      });
    }

    const learningStartAt = getIntelligenceLearningStartAt();
    const requestedDateFrom = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const dateFrom = new Date(
      Math.max(Date.parse(requestedDateFrom), Date.parse(learningStartAt))
    ).toISOString();

    const visitorIds = Array.from(new Set(targets.map((item) => item.visitor_id)));
    const allRows = [];

    // Consultas em blocos evitam uma expressão IN excessiva e preservam memória histórica
    // suficiente para cada visitante sem depender de dados enviados pelo painel.
    for (const visitorChunk of chunk(visitorIds, 40)) {
      const { data, error } = await supabaseAdmin
        .from("lead_events")
        .select("session_id,visitor_id,event_type,page,section,created_at")
        .in("visitor_id", visitorChunk)
        .in("event_type", INTENT_SIGNAL_EVENT_TYPES)
        .gte("created_at", dateFrom)
        .order("created_at", { ascending: true })
        .limit(12000);

      if (error) throw error;
      allRows.push(...(data || []));
    }

    const rowsByVisitor = new Map();
    for (const row of allRows) {
      if (!row?.visitor_id) continue;
      const rows = rowsByVisitor.get(row.visitor_id) || [];
      rows.push(row);
      rowsByVisitor.set(row.visitor_id, rows);
    }

    const scored = targets.map((target) => {
      const rows = rowsByVisitor.get(target.visitor_id) || [];
      const hasTargetSession = rows.some((row) => row?.session_id === target.session_id);
      const profile = buildIntentProfile(rows, {
        currentSessionId: target.session_id,
        learningStartAt,
      });
      const score = buildLeadScore(profile);

      return {
        visitor_id: target.visitor_id,
        session_id: target.session_id,
        session_signals_found: hasTargetSession,
        ...score,
      };
    });

    scored.sort((a, b) => intelligenceQueueOrder(b) - intelligenceQueueOrder(a));

    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    return res.status(200).json({
      success: true,
      period: { days, from: dateFrom, to: new Date().toISOString() },
      data: {
        version: "lead-score-v3.1.3-observer",
        mode: "observation",
        requested: targets.length,
        scored: scored.length,
        price_affinity_used: false,
        leads: scored,
      },
    });
  } catch (error) {
    console.error("ADMIN INTELLIGENCE LEAD SCORE BATCH ERROR:", error);
    return res.status(500).json({
      success: false,
      message: "Não foi possível calcular a fila inteligente de leads.",
    });
  }
});

router.get("/lead-score/visitor/:visitorId", async (req, res) => {
  try {
    const visitorId = normalizeId(req.params.visitorId);
    const sessionId = normalizeId(req.query.session_id || req.query.sessionId);
    const days = Math.min(toPositiveInt(req.query.days, 30), 90);

    if (!visitorId) {
      return res.status(400).json({ success: false, message: "visitorId inválido." });
    }

    const learningStartAt = getIntelligenceLearningStartAt();
    const requestedDateFrom = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const dateFrom = new Date(Math.max(Date.parse(requestedDateFrom), Date.parse(learningStartAt))).toISOString();

    const { data, error } = await supabaseAdmin
      .from("lead_events")
      .select("session_id,visitor_id,event_type,page,section,created_at")
      .eq("visitor_id", visitorId)
      .in("event_type", INTENT_SIGNAL_EVENT_TYPES)
      .gte("created_at", dateFrom)
      .order("created_at", { ascending: true })
      .limit(2500);

    if (error) throw error;

    const rows = data || [];
    const effectiveSessionId =
      sessionId || rows.slice().reverse().find((row) => row.session_id)?.session_id || null;
    const profile = buildIntentProfile(rows, {
      currentSessionId: effectiveSessionId,
      learningStartAt,
    });
    const score = buildLeadScore(profile);

    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    return res.status(200).json({
      success: true,
      visitor_id: visitorId,
      session_id: effectiveSessionId,
      data: score,
    });
  } catch (error) {
    console.error("ADMIN INTELLIGENCE LEAD SCORE VISITOR ERROR:", error);
    return res.status(500).json({
      success: false,
      message: "Não foi possível calcular o lead score deste visitante.",
    });
  }
});

router.get("/lead-score/overview", async (req, res) => {
  try {
    const days = Math.min(toPositiveInt(req.query.days, 7), 30);
    const learningStartAt = getIntelligenceLearningStartAt();
    const requestedDateFrom = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const dateFrom = new Date(Math.max(Date.parse(requestedDateFrom), Date.parse(learningStartAt))).toISOString();

    const { data, error } = await supabaseAdmin
      .from("lead_events")
      .select("session_id,visitor_id,event_type,page,section,created_at")
      .in("event_type", INTENT_SIGNAL_EVENT_TYPES)
      .gte("created_at", dateFrom)
      .order("created_at", { ascending: true })
      .limit(20000);

    if (error) throw error;

    const byVisitor = new Map();
    for (const row of data || []) {
      if (!row?.visitor_id) continue;
      const list = byVisitor.get(row.visitor_id) || [];
      list.push(row);
      byVisitor.set(row.visitor_id, list);
    }

    const scored = [];
    for (const [visitorId, rows] of byVisitor.entries()) {
      const currentSessionId = rows.slice().reverse().find((row) => row.session_id)?.session_id || null;
      const profile = buildIntentProfile(rows, { currentSessionId, learningStartAt });
      scored.push({ visitor_id: visitorId, ...buildLeadScore(profile) });
    }

    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    return res.status(200).json({
      success: true,
      period: { days, from: dateFrom, to: new Date().toISOString() },
      data: buildLeadScoreOverview(scored),
    });
  } catch (error) {
    console.error("ADMIN INTELLIGENCE LEAD SCORE OVERVIEW ERROR:", error);
    return res.status(500).json({
      success: false,
      message: "Não foi possível montar o panorama de lead score.",
    });
  }
});

export default router;
