import express from "express";
import { supabaseAdmin } from "../config/supabase.js";
import { requireAdminAuth } from "../middlewares/auth.middleware.js";
import { requireMasterAdmin } from "../middlewares/masterAdmin.middleware.js";
import {
  buildIntentOverview,
  buildIntentProfile,
  INTENT_SIGNAL_EVENT_TYPES,
} from "../intelligence/intent.engine.js";

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

router.use(requireAdminAuth, requireMasterAdmin);

router.get("/intent/overview", async (req, res) => {
  try {
    const days = Math.min(toPositiveInt(req.query.days, 7), 30);
    const dateFrom = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

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

    const overview = buildIntentOverview(data || []);

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

    const dateFrom = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

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

export default router;
