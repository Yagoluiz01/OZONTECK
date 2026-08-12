import express from "express";
import rateLimit from "express-rate-limit";
import { supabaseAdmin } from "../config/supabase.js";
import {
  buildIntentProfile,
  INTENT_SIGNAL_EVENT_TYPES,
} from "../intelligence/intent.engine.js";

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

function normalizeId(value, maxLength = 180) {
  const text = String(value || "").trim();
  if (!text) return null;
  return text.slice(0, maxLength);
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

    const { data: sessionRow, error: sessionError } = await supabaseAdmin
      .from("lead_sessions")
      .select("id")
      .eq("session_id", sessionId)
      .eq("visitor_id", visitorId)
      .maybeSingle();

    if (sessionError) {
      console.error("STORE INTELLIGENCE SESSION VALIDATION ERROR:", sessionError);
      return res.status(500).json({
        success: false,
        message: "Não foi possível validar a sessão agora.",
      });
    }

    if (!sessionRow?.id) {
      return res.status(404).json({
        success: false,
        message: "Sessão de inteligência ainda não disponível.",
      });
    }

    const dateFrom = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    const { data, error } = await supabaseAdmin
      .from("lead_events")
      .select("session_id,visitor_id,event_type,page,section,created_at")
      .eq("visitor_id", visitorId)
      .in("event_type", INTENT_SIGNAL_EVENT_TYPES)
      .gte("created_at", dateFrom)
      .order("created_at", { ascending: true })
      .limit(1500);

    if (error) {
      console.error("STORE INTELLIGENCE INTENT ERROR:", error);
      return res.status(500).json({
        success: false,
        message: "Não foi possível calcular a intenção agora.",
      });
    }

    const profile = buildIntentProfile(data || [], {
      currentSessionId: sessionId,
    });

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

export default router;
