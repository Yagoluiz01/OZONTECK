import express from "express";
import supabase from "../config/supabase.js";

const router = express.Router();

function toPositiveInt(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? Math.floor(num) : fallback;
}

function normalizeText(value) {
  const text = String(value || "").trim();
  return text || null;
}

function nowIso() {
  return new Date().toISOString();
}

async function findSession(sessionId) {
  const { data, error } = await supabase
    .from("lead_sessions")
    .select("id, session_id, visitor_id, started_at, ended_at, last_page, last_section, duration_seconds, created_at")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: false })
    .limit(1);

  if (error) {
    return { data: null, error };
  }

  return {
    data: Array.isArray(data) && data.length ? data[0] : null,
    error: null,
  };
}

async function ensureSessionExists({
  sessionId,
  visitorId = null,
  page = null,
  section = null,
}) {
  const existing = await findSession(sessionId);

  if (existing.error) {
    return {
      ok: false,
      message: existing.error.message,
      details: existing.error,
    };
  }

  if (existing.data?.id) {
    return {
      ok: true,
      session: existing.data,
    };
  }

  const payload = {
    session_id: sessionId,
    visitor_id: normalizeText(visitorId),
    started_at: nowIso(),
    ended_at: null,
    last_page: normalizeText(page),
    last_section: normalizeText(section),
    duration_seconds: 0,
  };

  const { data, error } = await supabase
    .from("lead_sessions")
    .insert([payload])
    .select("*")
    .single();

  if (error) {
    console.error("TRACKING ENSURE SESSION INSERT ERROR:", error);
    return {
      ok: false,
      message: error.message,
      details: error,
    };
  }

  return {
    ok: true,
    session: data,
  };
}

router.post("/event", async (req, res) => {
  try {
    const {
      session_id,
      visitor_id = null,
      event_type,
      page = null,
      section = null,
      duration_ms = 0,
    } = req.body || {};

    const sessionId = normalizeText(session_id);
    const visitorId = normalizeText(visitor_id);
    const eventType = normalizeText(event_type);
    const normalizedPage = normalizeText(page);
    const normalizedSection = normalizeText(section);

    if (!sessionId || !eventType) {
      return res.status(400).json({
        success: false,
        message: "session_id e event_type são obrigatórios",
      });
    }

    const ensuredSession = await ensureSessionExists({
      sessionId,
      visitorId,
      page: normalizedPage,
      section: normalizedSection,
    });

    if (!ensuredSession.ok) {
      return res.status(500).json({
        success: false,
        message: "Erro ao garantir sessão de tracking",
        details: ensuredSession.details || ensuredSession.message,
      });
    }

    const payload = {
      session_id: sessionId,
      visitor_id: visitorId,
      event_type: eventType,
      page: normalizedPage,
      section: normalizedSection,
      duration_ms: Number(duration_ms) || 0,
    };

    const { error } = await supabase.from("lead_events").insert([payload]);

    if (error) {
      console.error("TRACKING EVENT ERROR:", error);
      return res.status(500).json({
        success: false,
        message: error.message,
        details: error,
      });
    }

    return res.status(200).json({
      success: true,
      message: "Evento registrado com sucesso",
    });
  } catch (error) {
    console.error("TRACKING EVENT INTERNAL ERROR:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Erro ao registrar evento",
    });
  }
});

router.post("/session/end", async (req, res) => {
  try {
    const {
      session_id,
      visitor_id = null,
      last_page = null,
      last_section = null,
      duration_seconds = 0,
    } = req.body || {};

    const sessionId = normalizeText(session_id);
    const visitorId = normalizeText(visitor_id);
    const lastPage = normalizeText(last_page);
    const lastSection = normalizeText(last_section);
    const durationSeconds = Number(duration_seconds) || 0;

    if (!sessionId) {
      return res.status(400).json({
        success: false,
        message: "session_id é obrigatório",
      });
    }

    const existingSession = await findSession(sessionId);

    if (existingSession.error) {
      console.error("TRACKING SESSION FIND ERROR:", existingSession.error);
      return res.status(500).json({
        success: false,
        message: existingSession.error.message,
        details: existingSession.error,
      });
    }

    if (existingSession.data?.id) {
      const { error: updateError } = await supabase
        .from("lead_sessions")
        .update({
          visitor_id: visitorId,
          ended_at: nowIso(),
          last_page: lastPage,
          last_section: lastSection,
          duration_seconds: durationSeconds,
        })
        .eq("id", existingSession.data.id);

      if (updateError) {
        console.error("TRACKING SESSION UPDATE ERROR:", updateError);
        return res.status(500).json({
          success: false,
          message: updateError.message,
          details: updateError,
        });
      }
    } else {
      const { error: insertError } = await supabase.from("lead_sessions").insert([
        {
          session_id: sessionId,
          visitor_id: visitorId,
          started_at: nowIso(),
          ended_at: nowIso(),
          last_page: lastPage,
          last_section: lastSection,
          duration_seconds: durationSeconds,
        },
      ]);

      if (insertError) {
        console.error("TRACKING SESSION INSERT ERROR:", insertError);
        return res.status(500).json({
          success: false,
          message: insertError.message,
          details: insertError,
        });
      }
    }

    return res.status(200).json({
      success: true,
      message: "Sessão finalizada com sucesso",
    });
  } catch (error) {
    console.error("TRACKING SESSION END INTERNAL ERROR:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Erro ao finalizar sessão",
    });
  }
});

router.get("/sessions", async (req, res) => {
  try {
    const page = normalizeText(req.query.page);
    const section = normalizeText(req.query.section);
    const dateFrom = normalizeText(req.query.date_from);
    const dateTo = normalizeText(req.query.date_to);
    const minDuration = toPositiveInt(req.query.min_duration, 0);
    const limit = toPositiveInt(req.query.limit, 200);

    let query = supabase
      .from("lead_sessions")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(limit);

    if (page) query = query.eq("last_page", page);
    if (section) query = query.eq("last_section", section);
    if (dateFrom) query = query.gte("created_at", dateFrom);
    if (dateTo) query = query.lte("created_at", dateTo);
    if (minDuration > 0) query = query.gte("duration_seconds", minDuration);

    const { data, error } = await query;

    if (error) {
      console.error("TRACKING GET SESSIONS ERROR:", error);
      return res.status(500).json({
        success: false,
        message: error.message,
        details: error,
      });
    }

    return res.status(200).json({
      success: true,
      data,
    });
  } catch (error) {
    console.error("TRACKING GET SESSIONS INTERNAL ERROR:", error);
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

router.get("/events", async (req, res) => {
  try {
    const page = normalizeText(req.query.page);
    const section = normalizeText(req.query.section);
    const eventType = normalizeText(req.query.event_type);
    const sessionId = normalizeText(req.query.session_id);
    const dateFrom = normalizeText(req.query.date_from);
    const dateTo = normalizeText(req.query.date_to);
    const limit = toPositiveInt(req.query.limit, 500);

    let query = supabase
      .from("lead_events")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(limit);

    if (page) query = query.eq("page", page);
    if (section) query = query.eq("section", section);
    if (eventType) query = query.eq("event_type", eventType);
    if (sessionId) query = query.eq("session_id", sessionId);
    if (dateFrom) query = query.gte("created_at", dateFrom);
    if (dateTo) query = query.lte("created_at", dateTo);

    const { data, error } = await query;

    if (error) {
      console.error("TRACKING GET EVENTS ERROR:", error);
      return res.status(500).json({
        success: false,
        message: error.message,
        details: error,
      });
    }

    return res.status(200).json({
      success: true,
      data,
    });
  } catch (error) {
    console.error("TRACKING GET EVENTS INTERNAL ERROR:", error);
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

export default router;