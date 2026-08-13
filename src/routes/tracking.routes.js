import express from "express";
import rateLimit from "express-rate-limit";
import { supabaseAdmin } from "../config/supabase.js";
import {
  buildIntentProfile,
  INTENT_SIGNAL_EVENT_TYPES,
  getIntelligenceLearningStartAt,
} from "../intelligence/intent.engine.js";
import { buildLeadScore } from "../intelligence/leadScore.engine.js";
import { notifyRecoveryReadyLeads } from "../services/leadRecoveryNotification.service.js";

import { requireAdminAuth } from "../middlewares/auth.middleware.js";
import { requireMasterAdmin } from "../middlewares/masterAdmin.middleware.js";

const router = express.Router();

const publicTrackingLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 240,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Muitos eventos de navegação. Tente novamente em alguns minutos.",
  },
});

function toPositiveInt(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? Math.floor(num) : fallback;
}

function normalizeText(value, maxLength = 500) {
  const text = String(value || "").trim().slice(0, Math.max(1, maxLength));
  return text || null;
}

function nowIso() {
  return new Date().toISOString();
}

async function loadRecoveryIntelligence(visitorId, sessionId) {
  const safeVisitorId = normalizeText(visitorId, 180);
  const safeSessionId = normalizeText(sessionId, 180);
  if (!safeVisitorId || !safeSessionId) return null;

  const learningStartAt = getIntelligenceLearningStartAt();
  const rollingStart = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const dateFrom = new Date(
    Math.max(Date.parse(rollingStart), Date.parse(learningStartAt))
  ).toISOString();

  const { data, error } = await supabaseAdmin
    .from("lead_events")
    .select("session_id,visitor_id,event_type,page,section,created_at")
    .eq("visitor_id", safeVisitorId)
    .in("event_type", INTENT_SIGNAL_EVENT_TYPES)
    .gte("created_at", dateFrom)
    .order("created_at", { ascending: true })
    .limit(2500);

  if (error) throw error;

  const rows = data || [];
  if (!rows.some((row) => row?.session_id === safeSessionId)) return null;

  const profile = buildIntentProfile(rows, {
    currentSessionId: safeSessionId,
    learningStartAt,
  });
  return buildLeadScore(profile);
}

const TRACKING_TIMESTAMP_OFFSET = String(
  process.env.TRACKING_TIMESTAMP_OFFSET || "Z"
).trim();

function parseTrackingDateMs(value) {
  const raw = String(value || "").trim();
  if (!raw) return NaN;

  // lead_events/lead_sessions usam timestamp sem timezone.
  // Se já vier Z ou offset explícito, preserve.
  const hasExplicitTimezone = /(?:Z|[+-]\\d{2}:?\\d{2})$/i.test(raw);
  const normalized = hasExplicitTimezone
    ? raw
    : `${raw}${TRACKING_TIMESTAMP_OFFSET}`;

  return Date.parse(normalized);
}

function behaviorWaitSeconds(score = {}, nowMs = Date.now()) {
  const recovery = score?.recovery_priority || {};
  if (recovery.eligible_by_behavior !== true || recovery.ready_by_behavior === true) return 0;

  const lastSignalMs = parseTrackingDateMs(score?.last_signal_at);
  const waitMinutes = Math.max(0, Number(recovery.minimum_wait_minutes || 0));
  if (!Number.isFinite(lastSignalMs) || !waitMinutes) return 0;

  return Math.max(0, Math.ceil((lastSignalMs + waitMinutes * 60 * 1000 - nowMs) / 1000));
}


function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits || null;
}

function normalizeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function safeJsonParse(value, fallback = null) {
  try {
    return JSON.parse(String(value || ""));
  } catch {
    return fallback;
  }
}


const CHECKOUT_RECOVERY_DELAY_MINUTES = 5;
const ORDER_RECOVERY_DELAY_MINUTES = 10;
const RECOVERY_ORDER_EVENT_TYPES = [
  "checkout_order_created",
  "checkout_payment_confirmed",
  "payment_success",
  "purchase",
];
const ADMIN_RECOVERY_EVENT_TYPE = "admin_recovery_started";

function clampMinutes(value, fallback, max = 24 * 60) {
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes < 0) return fallback;
  return Math.min(Math.floor(minutes), max);
}

function addMinutesIso(value, minutes) {
  const time = parseTrackingDateMs(value);
  if (!Number.isFinite(time)) return null;
  return new Date(time + minutes * 60 * 1000).toISOString();
}

function secondsUntil(value, nowMs = Date.now()) {
  const time = parseTrackingDateMs(value);
  if (!Number.isFinite(time)) return 0;
  return Math.max(0, Math.ceil((time - nowMs) / 1000));
}

function isPaidStatus(value) {
  const status = String(value || "").trim().toLowerCase();
  return ["paid", "pago", "approved", "aprovado", "confirmed", "confirmado"].includes(status);
}

function parseTrackingMetadata(value) {
  const parsed = safeJsonParse(value, null);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
}

function normalizeOrderTrackingEvent(row = {}) {
  const metadata = parseTrackingMetadata(row.section);

  return {
    id: row.id,
    session_id: row.session_id,
    event_type: row.event_type,
    created_at: row.created_at,
    order_number: normalizeText(
      metadata.order_number ||
        metadata.orderNumber ||
        metadata.external_reference ||
        metadata.externalReference
    ),
    payment_status: normalizeText(metadata.payment_status || metadata.paymentStatus),
    payment_gateway: normalizeText(metadata.payment_gateway || metadata.paymentGateway),
    payment_method: normalizeText(metadata.payment_method || metadata.paymentMethod),
  };
}

function applyCheckoutRecoveryState(lead, options = {}) {
  const nowMs = Number(options.nowMs || Date.now());
  const checkoutDelayMinutes = Number(options.checkoutDelayMinutes ?? CHECKOUT_RECOVERY_DELAY_MINUTES);
  const orderDelayMinutes = Number(options.orderDelayMinutes ?? ORDER_RECOVERY_DELAY_MINUTES);
  const orderEvent = options.orderEvent || null;
  const order = options.order || null;
  const paid = isPaidStatus(order?.payment_status) || isPaidStatus(orderEvent?.payment_status);
  const hasPhone = Boolean(lead.phone_digits || normalizePhone(lead.phone));

  const base = {
    ...lead,
    order_number: order?.order_number || orderEvent?.order_number || null,
    order_payment_status: order?.payment_status || orderEvent?.payment_status || null,
    order_status: order?.order_status || null,
    payment_gateway: order?.payment_gateway || orderEvent?.payment_gateway || null,
    recovery_delay_minutes: checkoutDelayMinutes,
    order_recovery_delay_minutes: orderDelayMinutes,
    recovery_status: "waiting",
    recovery_label: "Aguardando prazo",
    recovery_message: "Cliente ainda pode estar finalizando o checkout.",
    recovery_ready_at: addMinutesIso(lead.created_at, checkoutDelayMinutes),
    wait_seconds_remaining: 0,
    is_recoverable: false,
  };

  if (paid) {
    return {
      ...base,
      recovery_status: "converted",
      recovery_label: "Pedido pago",
      recovery_message: "Cliente já confirmou o pagamento. Não chamar para recuperação.",
      recovery_ready_at: null,
      wait_seconds_remaining: 0,
      is_recoverable: false,
    };
  }

  if (orderEvent) {
    const readyAt = addMinutesIso(orderEvent.created_at, orderDelayMinutes);
    const remaining = secondsUntil(readyAt, nowMs);
    const ready = remaining <= 0;

    if (!hasPhone) {
      return {
        ...base,
        recovery_status: "missing_phone",
        recovery_label: "Sem WhatsApp",
        recovery_message: "Pedido criado, mas ainda não existe telefone para chamar no WhatsApp.",
        recovery_ready_at: readyAt,
        wait_seconds_remaining: remaining,
        is_recoverable: false,
      };
    }

    return {
      ...base,
      recovery_status: ready ? "payment_pending" : "order_waiting",
      recovery_label: ready ? "Pagamento pendente" : "Pedido em andamento",
      recovery_message: ready
        ? "Pedido criado e prazo mínimo finalizado. Pode chamar com cuidado."
        : "Pedido foi criado recentemente. Aguarde antes de chamar para não atrapalhar a finalização.",
      recovery_ready_at: readyAt,
      wait_seconds_remaining: remaining,
      is_recoverable: ready,
    };
  }

  const readyAt = addMinutesIso(lead.created_at, checkoutDelayMinutes);
  const remaining = secondsUntil(readyAt, nowMs);
  const ready = remaining <= 0;

  if (!hasPhone) {
    return {
      ...base,
      recovery_status: "missing_phone",
      recovery_label: "Sem WhatsApp",
      recovery_message: "Lead captado, mas sem telefone para recuperação pelo WhatsApp.",
      recovery_ready_at: readyAt,
      wait_seconds_remaining: remaining,
      is_recoverable: false,
    };
  }

  return {
    ...base,
    recovery_status: ready ? "ready" : "waiting",
    recovery_label: ready ? "WhatsApp pronto" : "Aguardando prazo",
    recovery_message: ready
      ? "Prazo mínimo finalizado. Lead liberado para recuperação."
      : "Cliente ainda pode estar finalizando a compra. Aguarde o prazo mínimo.",
    recovery_ready_at: readyAt,
    wait_seconds_remaining: remaining,
    is_recoverable: ready,
  };
}

function normalizeLeadItems(items = []) {
  if (!Array.isArray(items)) return [];

  return items
    .slice(0, 12)
    .map((item) => ({
      id: normalizeText(item?.id || item?.slug || item?.sku || item?.ref),
      name: normalizeText(item?.name || item?.nome || item?.title) || "Produto OZONTECK",
      quantity: Math.max(1, Math.floor(normalizeNumber(item?.quantity || item?.quantidade, 1))),
      price: normalizeNumber(item?.price || item?.preco || item?.value, 0),
    }))
    .filter((item) => item.name);
}

function normalizeCheckoutLeadPayload(body = {}) {
  const contact = body.contact || body.customer || {};
  const checkout = body.checkout || body.summary || {};

  const items = normalizeLeadItems(checkout.items || body.items || []);
  const total = normalizeNumber(checkout.total || body.total, 0);
  const subtotal = normalizeNumber(checkout.subtotal || body.subtotal, 0);
  const shippingAmount = normalizeNumber(checkout.shippingAmount || checkout.shipping_amount || body.shippingAmount, 0);

  return {
    contact: {
      name: normalizeText(contact.name || contact.nome || body.name || body.nome),
      email: normalizeText(contact.email || body.email),
      phone: normalizeText(contact.phone || contact.telefone || body.phone || body.telefone),
      phone_digits: normalizePhone(contact.phone || contact.telefone || body.phone || body.telefone),
      city: normalizeText(contact.city || contact.cidade || body.city || body.cidade),
      state: normalizeText(contact.state || contact.estado || body.state || body.estado),
      zip_code: normalizeText(contact.zipCode || contact.cep || body.zipCode || body.cep),
    },
    checkout: {
      stage: normalizeText(body.stage || checkout.stage) || "checkout",
      page: normalizeText(body.page || checkout.page) || "checkout.html",
      url: normalizeText(body.url || checkout.url),
      subtotal,
      shipping_amount: shippingAmount,
      total,
      payment_method: normalizeText(checkout.paymentMethod || checkout.payment_method || body.paymentMethod),
      selected_shipping: checkout.selectedShipping || checkout.selected_shipping || null,
      items,
      item_count: items.reduce((sum, item) => sum + Number(item.quantity || 0), 0),
      product_summary: items.length
        ? items
            .slice(0, 3)
            .map((item) => `${item.quantity}x ${item.name}`)
            .join(", ")
        : null,
    },
  };
}

function buildCheckoutLeadRecord(row = {}) {
  const parsed = safeJsonParse(row.section, {}) || {};
  const contact = parsed.contact || {};
  const checkout = parsed.checkout || {};

  return {
    id: row.id,
    session_id: row.session_id,
    visitor_id: row.visitor_id,
    created_at: row.created_at,
    updated_at: row.created_at,
    page: row.page || checkout.page || "checkout.html",
    stage: checkout.stage || "checkout",
    name: contact.name || null,
    email: contact.email || null,
    phone: contact.phone || null,
    phone_digits: contact.phone_digits || normalizePhone(contact.phone),
    city: contact.city || null,
    state: contact.state || null,
    zip_code: contact.zip_code || null,
    subtotal: normalizeNumber(checkout.subtotal, 0),
    shipping_amount: normalizeNumber(checkout.shipping_amount, 0),
    total: normalizeNumber(checkout.total, 0),
    payment_method: checkout.payment_method || null,
    product_summary: checkout.product_summary || null,
    item_count: normalizeNumber(checkout.item_count, 0),
    items: Array.isArray(checkout.items) ? checkout.items : [],
    selected_shipping: checkout.selected_shipping || null,
    url: checkout.url || null,
  };
}

async function findSession(sessionId) {
  const { data, error } = await supabaseAdmin
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

  const { data, error } = await supabaseAdmin
    .from("lead_sessions")
    .insert([payload])
    .select("*")
    .single();

  if (error) {
    // Dois eventos podem chegar juntos na primeira abertura da página.
    // Nesse caso uma requisição cria a sessão e a outra pode receber conflito.
    // Reconsultar evita transformar essa condição normal em erro 500.
    const sessionAfterInsert = await findSession(sessionId);

    if (!sessionAfterInsert.error && sessionAfterInsert.data?.id) {
      return {
        ok: true,
        session: sessionAfterInsert.data,
        recoveredFromConcurrentInsert: true,
      };
    }

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


router.post("/checkout-contact", publicTrackingLimiter, async (req, res) => {
  try {
    const { session_id, visitor_id = null } = req.body || {};
    const sessionId = normalizeText(session_id);
    const visitorId = normalizeText(visitor_id);

    if (!sessionId) {
      return res.status(400).json({
        success: false,
        message: "session_id é obrigatório",
      });
    }

    const normalized = normalizeCheckoutLeadPayload(req.body || {});
    const hasContact =
      normalized.contact.name || normalized.contact.email || normalized.contact.phone_digits;

    if (!hasContact) {
      return res.status(400).json({
        success: false,
        message: "Informe pelo menos nome, e-mail ou telefone para recuperar o lead",
      });
    }

    const ensuredSession = await ensureSessionExists({
      sessionId,
      visitorId,
      page: normalized.checkout.page,
      section: "checkout_contact",
    });

    if (!ensuredSession.ok) {
      return res.status(500).json({
        success: false,
        message: "Erro ao garantir sessão de checkout",
      });
    }

    const eventPayload = {
      session_id: sessionId,
      visitor_id: visitorId,
      event_type: "checkout_contact",
      page: normalized.checkout.page,
      section: JSON.stringify(normalized),
      duration_ms: 0,
    };

    const { data, error } = await supabaseAdmin
      .from("lead_events")
      .insert([eventPayload])
      .select("*")
      .single();

    if (error) {
      console.error("TRACKING CHECKOUT CONTACT ERROR:", error);
      return res.status(500).json({
        success: false,
        message: "Erro ao registrar evento de checkout.",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Lead de checkout registrado com sucesso",
      data: buildCheckoutLeadRecord(data),
    });
  } catch (error) {
    console.error("TRACKING CHECKOUT CONTACT INTERNAL ERROR:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Erro ao registrar lead de checkout",
    });
  }
});

router.post("/event", publicTrackingLimiter, async (req, res) => {
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
      });
    }

    const payload = {
      session_id: sessionId,
      visitor_id: visitorId,
      event_type: eventType,
      page: normalizedPage,
      section: normalizedSection,
      duration_ms: Math.max(0, Math.min(Number(duration_ms) || 0, 24 * 60 * 60 * 1000)),
    };

    const { error } = await supabaseAdmin.from("lead_events").insert([payload]);

    if (error) {
      console.error("TRACKING EVENT ERROR:", error);
      return res.status(500).json({
        success: false,
        message: "Erro ao registrar evento de navegação.",
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

router.post("/session/end", publicTrackingLimiter, async (req, res) => {
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
    const durationSeconds = Math.max(0, Math.min(Number(duration_seconds) || 0, 24 * 60 * 60));

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
      const { error: updateError } = await supabaseAdmin
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
      const { error: insertError } = await supabaseAdmin.from("lead_sessions").insert([
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

const FUNNEL_STEP_DEFINITIONS = [
  { key: "product_view", label: "Produto visualizado", events: ["product_view"] },
  { key: "add_to_cart", label: "Adicionou ao carrinho", events: ["add_to_cart"] },
  { key: "cart_view", label: "Abriu o carrinho", events: ["cart_view"] },
  { key: "checkout_view", label: "Abriu o checkout", events: ["checkout_view", "checkout_start"] },
  { key: "shipping_selected", label: "Frete definido", events: ["shipping_selected", "shipping_calculated"] },
  { key: "checkout_submitted", label: "Avançou para pagamento", events: ["checkout_submitted"] },
  { key: "payment_view", label: "Abriu pagamento", events: ["payment_view"] },
  { key: "payment_method_selected", label: "Escolheu método", events: ["payment_method_selected"] },
  { key: "order_created", label: "Pedido criado", events: ["checkout_order_created"] },
  { key: "pix_generated", label: "PIX gerado", events: ["pix_generated"] },
  { key: "payment_confirmed", label: "Pagamento confirmado", events: ["payment_confirmed", "payment_success", "purchase"] },
];

function percent(part, total) {
  if (!total) return 0;
  return Number(((part / total) * 100).toFixed(1));
}

router.get("/funnel", requireAdminAuth, requireMasterAdmin, async (req, res) => {
  try {
    const days = Math.min(toPositiveInt(req.query.days, 7), 90);
    const dateFrom = normalizeText(req.query.date_from) || new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const dateTo = normalizeText(req.query.date_to) || nowIso();
    const eventNames = Array.from(new Set([
      ...FUNNEL_STEP_DEFINITIONS.flatMap((step) => step.events),
      "payment_rejected",
      "payment_pending",
      "payment_error",
      "payment_attempt",
    ]));

    const { data, error } = await supabaseAdmin
      .from("lead_events")
      .select("session_id,event_type,section,created_at")
      .in("event_type", eventNames)
      .gte("created_at", dateFrom)
      .lte("created_at", dateTo)
      .order("created_at", { ascending: true })
      .limit(20000);

    if (error) {
      console.error("TRACKING FUNNEL ERROR:", error);
      return res.status(500).json({ success: false, message: "Erro ao carregar funil." });
    }

    const rows = Array.isArray(data) ? data : [];
    const eventCounts = new Map();
    const sessionSets = new Map();
    const paymentMethods = new Map();

    FUNNEL_STEP_DEFINITIONS.forEach((step) => {
      eventCounts.set(step.key, 0);
      sessionSets.set(step.key, new Set());
    });

    rows.forEach((row) => {
      const matchingStep = FUNNEL_STEP_DEFINITIONS.find((step) => step.events.includes(row.event_type));
      if (!matchingStep) return;
      eventCounts.set(matchingStep.key, (eventCounts.get(matchingStep.key) || 0) + 1);
      if (row.session_id) sessionSets.get(matchingStep.key).add(row.session_id);

      if (["payment_method_selected", "pix_generated", "payment_confirmed"].includes(matchingStep.key)) {
        const metadata = parseTrackingMetadata(row.section);
        const method = normalizeText(metadata.payment_method || metadata.paymentMethod) || "nao_informado";
        paymentMethods.set(method, (paymentMethods.get(method) || 0) + 1);
      }
    });

    const firstStepSessions = sessionSets.get("product_view") || new Set();
    let previousSessions = null;
    const steps = FUNNEL_STEP_DEFINITIONS.map((step, index) => {
      const currentSessions = sessionSets.get(step.key) || new Set();
      const uniqueSessions = currentSessions.size;
      const fromStart = Array.from(currentSessions).filter((id) => firstStepSessions.has(id)).length;
      const fromPrevious = previousSessions
        ? Array.from(currentSessions).filter((id) => previousSessions.has(id)).length
        : uniqueSessions;
      const result = {
        key: step.key,
        label: step.label,
        events: eventCounts.get(step.key) || 0,
        unique_sessions: uniqueSessions,
        continued_from_previous: fromPrevious,
        conversion_from_start: index === 0 ? 100 : percent(fromStart, firstStepSessions.size),
        conversion_from_previous: index === 0 ? 100 : percent(fromPrevious, previousSessions?.size || 0),
      };
      previousSessions = currentSessions;
      return result;
    });

    return res.status(200).json({
      success: true,
      period: { from: dateFrom, to: dateTo, days },
      sampled_events: rows.length,
      steps,
      payment_methods: Object.fromEntries(Array.from(paymentMethods.entries()).sort((a, b) => b[1] - a[1])),
      rejected_payments: rows.filter((row) => row.event_type === "payment_rejected").length,
    });
  } catch (error) {
    console.error("TRACKING FUNNEL INTERNAL ERROR:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Erro ao montar funil de conversão",
    });
  }
});

router.get("/sessions", requireAdminAuth, requireMasterAdmin, async (req, res) => {
  try {
    const page = normalizeText(req.query.page);
    const section = normalizeText(req.query.section);
    const dateFrom = normalizeText(req.query.date_from);
    const dateTo = normalizeText(req.query.date_to);
    const minDuration = toPositiveInt(req.query.min_duration, 0);
    const limit = Math.min(toPositiveInt(req.query.limit, 200), 500);

    let query = supabaseAdmin
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

router.get("/events", requireAdminAuth, requireMasterAdmin, async (req, res) => {
  try {
    const page = normalizeText(req.query.page);
    const section = normalizeText(req.query.section);
    const eventType = normalizeText(req.query.event_type);
    const sessionId = normalizeText(req.query.session_id);
    const dateFrom = normalizeText(req.query.date_from);
    const dateTo = normalizeText(req.query.date_to);
    const limit = Math.min(toPositiveInt(req.query.limit, 500), 1000);

    let query = supabaseAdmin
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


router.post("/checkout-leads/:sessionId/recovery-started", requireAdminAuth, requireMasterAdmin, async (req, res) => {
  try {
    const sessionId = normalizeText(req.params.sessionId, 180);
    const leadId = normalizeText(req.body?.lead_id || req.body?.leadId, 180);
    const orderNumberFromClient = normalizeText(req.body?.order_number || req.body?.orderNumber, 180);
    const checkoutDelayMinutes = CHECKOUT_RECOVERY_DELAY_MINUTES;
    const orderDelayMinutes = ORDER_RECOVERY_DELAY_MINUTES;

    if (!sessionId) {
      return res.status(400).json({
        success: false,
        message: "sessionId é obrigatório",
      });
    }

    const existingSession = await findSession(sessionId);
    if (existingSession.error) {
      console.error("TRACKING RECOVERY SESSION LOOKUP ERROR:", existingSession.error);
      return res.status(500).json({
        success: false,
        message: "Erro ao validar sessão do lead.",
      });
    }

    if (!existingSession.data?.id) {
      return res.status(404).json({
        success: false,
        message: "Sessão do lead não encontrada.",
      });
    }

    const { data: latestContactRows, error: latestContactError } = await supabaseAdmin
      .from("lead_events")
      .select("*")
      .eq("session_id", sessionId)
      .eq("event_type", "checkout_contact")
      .order("created_at", { ascending: false })
      .limit(1);

    if (latestContactError) {
      console.error("TRACKING RECOVERY CONTACT LOOKUP ERROR:", latestContactError);
      return res.status(500).json({
        success: false,
        message: "Erro ao validar oportunidade de recuperação.",
      });
    }

    const latestContact = Array.isArray(latestContactRows) && latestContactRows.length
      ? latestContactRows[0]
      : null;

    if (!latestContact?.id) {
      return res.status(404).json({
        success: false,
        message: "Lead de checkout não encontrado para esta sessão.",
      });
    }

    const lead = buildCheckoutLeadRecord(latestContact);

    const { data: orderEventRows, error: orderEventError } = await supabaseAdmin
      .from("lead_events")
      .select("id, session_id, event_type, section, created_at")
      .eq("session_id", sessionId)
      .in("event_type", RECOVERY_ORDER_EVENT_TYPES)
      .order("created_at", { ascending: false })
      .limit(1);

    if (orderEventError) {
      console.error("TRACKING RECOVERY ORDER EVENT LOOKUP ERROR:", orderEventError);
    }

    const orderEventRow = Array.isArray(orderEventRows) && orderEventRows.length
      ? orderEventRows[0]
      : null;
    const orderEvent = orderEventRow ? normalizeOrderTrackingEvent(orderEventRow) : null;

    let order = null;
    const trustedOrderNumber = orderEvent?.order_number || null;
    if (trustedOrderNumber) {
      const { data: orderRows, error: orderError } = await supabaseAdmin
        .from("orders")
        .select("id, order_number, payment_status, order_status, payment_gateway, total_amount, created_at")
        .eq("order_number", trustedOrderNumber)
        .limit(1);

      if (orderError) {
        console.error("TRACKING RECOVERY ORDER LOOKUP ERROR:", orderError);
      } else if (Array.isArray(orderRows) && orderRows.length) {
        order = orderRows[0];
      }
    }

    const recoveryState = applyCheckoutRecoveryState(lead, {
      nowMs: Date.now(),
      checkoutDelayMinutes,
      orderDelayMinutes,
      orderEvent,
      order,
    });

    if (!recoveryState.is_recoverable) {
      return res.status(409).json({
        success: false,
        message: recoveryState.recovery_message || "Lead ainda não está liberado para recuperação.",
        recovery_status: recoveryState.recovery_status,
        wait_seconds_remaining: recoveryState.wait_seconds_remaining,
      });
    }

    let recoveryIntelligence = null;
    try {
      recoveryIntelligence = await loadRecoveryIntelligence(
        existingSession.data.visitor_id,
        sessionId
      );
    } catch (intelligenceError) {
      // A proteção temporal do checkout continua autoritativa mesmo se a camada
      // comportamental estiver momentaneamente indisponível. O erro é auditado,
      // mas não derruba a operação administrativa inteira.
      console.error("TRACKING RECOVERY INTELLIGENCE ERROR:", intelligenceError);
    }

    if (recoveryIntelligence) {
      const behaviorRecovery = recoveryIntelligence.recovery_priority || {};

      if (behaviorRecovery.eligible_by_behavior !== true) {
        return res.status(409).json({
          success: false,
          message:
            behaviorRecovery.reason ||
            "A inteligência comportamental não considera este lead elegível para recuperação agora.",
          recovery_status: "behavior_not_eligible",
          lead_score: recoveryIntelligence.lead_score,
          intelligence_version: recoveryIntelligence.version,
        });
      }

      if (behaviorRecovery.ready_by_behavior !== true) {
        return res.status(409).json({
          success: false,
          message:
            behaviorRecovery.reason ||
            "A janela comportamental de segurança ainda não terminou.",
          recovery_status: "behavior_waiting",
          wait_seconds_remaining: behaviorWaitSeconds(recoveryIntelligence),
          lead_score: recoveryIntelligence.lead_score,
          intelligence_version: recoveryIntelligence.version,
        });
      }
    }

    const { data: priorRecoveryRows, error: priorRecoveryError } = await supabaseAdmin
      .from("lead_events")
      .select("id, created_at")
      .eq("session_id", sessionId)
      .eq("event_type", ADMIN_RECOVERY_EVENT_TYPE)
      .gte("created_at", latestContact.created_at)
      .order("created_at", { ascending: false })
      .limit(1);

    if (priorRecoveryError) {
      console.error("TRACKING RECOVERY PRIOR LOOKUP ERROR:", priorRecoveryError);
    }

    const priorRecovery = Array.isArray(priorRecoveryRows) && priorRecoveryRows.length
      ? priorRecoveryRows[0]
      : null;

    if (priorRecovery?.id) {
      return res.status(200).json({
        success: true,
        already_marked: true,
        recovered_at: priorRecovery.created_at,
      });
    }

    const payload = {
      session_id: sessionId,
      visitor_id: existingSession.data.visitor_id || null,
      event_type: ADMIN_RECOVERY_EVENT_TYPE,
      page: "admin/inteligencia-leads",
      section: JSON.stringify({
        action: "whatsapp_recovery_started",
        lead_id: leadId || latestContact.id,
        order_number: recoveryState.order_number || trustedOrderNumber || orderNumberFromClient || null,
        intelligence_version: recoveryIntelligence?.version || null,
        lead_score: recoveryIntelligence?.lead_score ?? null,
        recovery_priority: recoveryIntelligence?.recovery_priority?.key || null,
      }),
      duration_ms: 0,
    };

    const { data, error } = await supabaseAdmin
      .from("lead_events")
      .insert([payload])
      .select("id, session_id, event_type, created_at")
      .single();

    if (error) {
      console.error("TRACKING RECOVERY START INSERT ERROR:", error);
      return res.status(500).json({
        success: false,
        message: "Não foi possível registrar o início da recuperação.",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Recuperação marcada como iniciada.",
      data,
    });
  } catch (error) {
    console.error("TRACKING RECOVERY START INTERNAL ERROR:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Erro ao marcar recuperação",
    });
  }
});

router.get("/checkout-leads", requireAdminAuth, requireMasterAdmin, async (req, res) => {
  try {
    const dateFrom = normalizeText(req.query.date_from);
    const dateTo = normalizeText(req.query.date_to);
    const limit = Math.min(toPositiveInt(req.query.limit, 200), 500);
    const checkoutDelayMinutes = clampMinutes(
      req.query.recovery_delay_minutes,
      CHECKOUT_RECOVERY_DELAY_MINUTES
    );
    const orderDelayMinutes = clampMinutes(
      req.query.order_recovery_delay_minutes,
      ORDER_RECOVERY_DELAY_MINUTES
    );

    let query = supabaseAdmin
      .from("lead_events")
      .select("*")
      .eq("event_type", "checkout_contact")
      .order("created_at", { ascending: false })
      .limit(Math.min(limit * 4, 1000));

    if (dateFrom) query = query.gte("created_at", dateFrom);
    if (dateTo) query = query.lte("created_at", dateTo);

    const { data, error } = await query;

    if (error) {
      console.error("TRACKING GET CHECKOUT LEADS ERROR:", error);
      return res.status(500).json({
        success: false,
        message: error.message,
        details: error,
      });
    }

    const grouped = new Map();

    (Array.isArray(data) ? data : []).forEach((row) => {
      const lead = buildCheckoutLeadRecord(row);
      const key = lead.session_id || lead.id;

      if (!key) return;
      if (!lead.phone_digits && !lead.email && !lead.name) return;
      if (!grouped.has(key)) grouped.set(key, lead);
    });

    const groupedLeads = Array.from(grouped.values());
    const sessionIds = groupedLeads
      .map((lead) => normalizeText(lead.session_id))
      .filter(Boolean);

    const latestOrderEventBySession = new Map();

    if (sessionIds.length) {
      const { data: orderEvents, error: orderEventsError } = await supabaseAdmin
        .from("lead_events")
        .select("id, session_id, event_type, section, created_at")
        .in("session_id", sessionIds)
        .in("event_type", RECOVERY_ORDER_EVENT_TYPES)
        .order("created_at", { ascending: false })
        .limit(Math.min(sessionIds.length * 6, 1000));

      if (orderEventsError) {
        console.error("TRACKING GET CHECKOUT ORDER EVENTS ERROR:", orderEventsError);
      } else {
        (Array.isArray(orderEvents) ? orderEvents : []).forEach((row) => {
          const event = normalizeOrderTrackingEvent(row);
          if (!event.session_id) return;
          if (!latestOrderEventBySession.has(event.session_id)) {
            latestOrderEventBySession.set(event.session_id, event);
          }
        });
      }
    }

    const latestRecoveryStartedBySession = new Map();

    if (sessionIds.length) {
      const { data: recoveryEvents, error: recoveryEventsError } = await supabaseAdmin
        .from("lead_events")
        .select("id, session_id, event_type, created_at")
        .in("session_id", sessionIds)
        .eq("event_type", ADMIN_RECOVERY_EVENT_TYPE)
        .order("created_at", { ascending: false })
        .limit(Math.min(sessionIds.length * 3, 1000));

      if (recoveryEventsError) {
        console.error("TRACKING GET RECOVERY ACTIONS ERROR:", recoveryEventsError);
      } else {
        (Array.isArray(recoveryEvents) ? recoveryEvents : []).forEach((row) => {
          if (!row?.session_id || latestRecoveryStartedBySession.has(row.session_id)) return;
          latestRecoveryStartedBySession.set(row.session_id, row);
        });
      }
    }

    const orderNumbers = Array.from(latestOrderEventBySession.values())
      .map((event) => event.order_number)
      .filter(Boolean);
    const orderByNumber = new Map();

    if (orderNumbers.length) {
      const { data: orders, error: ordersError } = await supabaseAdmin
        .from("orders")
        .select("id, order_number, payment_status, order_status, payment_gateway, total_amount, created_at")
        .in("order_number", orderNumbers)
        .limit(Math.min(orderNumbers.length, 300));

      if (ordersError) {
        console.error("TRACKING GET CHECKOUT ORDERS ERROR:", ordersError);
      } else {
        (Array.isArray(orders) ? orders : []).forEach((order) => {
          if (order?.order_number) {
            orderByNumber.set(String(order.order_number), order);
          }
        });
      }
    }

    const nowMs = Date.now();
    let recoveredHiddenCount = 0;
    const leads = groupedLeads
      .filter((lead) => {
        const recoveryStarted = latestRecoveryStartedBySession.get(lead.session_id) || null;
        if (!recoveryStarted?.created_at) return true;

        const contactTime = Date.parse(lead.created_at || "");
        const recoveryTime = Date.parse(recoveryStarted.created_at || "");
        const recoveryCoversCurrentOpportunity =
          Number.isFinite(recoveryTime) &&
          (!Number.isFinite(contactTime) || recoveryTime >= contactTime);

        if (recoveryCoversCurrentOpportunity) recoveredHiddenCount += 1;
        return !recoveryCoversCurrentOpportunity;
      })
      .map((lead) => {
        const orderEvent = latestOrderEventBySession.get(lead.session_id) || null;
        const order = orderEvent?.order_number
          ? orderByNumber.get(String(orderEvent.order_number)) || null
          : null;

        return applyCheckoutRecoveryState(lead, {
          nowMs,
          checkoutDelayMinutes,
          orderDelayMinutes,
          orderEvent,
          order,
        });
      })
      .slice(0, limit);

    const { created: recoveryNotificationsCreated } = await notifyRecoveryReadyLeads(leads, { nowMs });

    return res.status(200).json({
      success: true,
      meta: {
        checkout_recovery_delay_minutes: checkoutDelayMinutes,
        order_recovery_delay_minutes: orderDelayMinutes,
        recovered_hidden_count: recoveredHiddenCount,
        recovery_notifications_created: recoveryNotificationsCreated,
      },
      data: leads,
    });
  } catch (error) {
    console.error("TRACKING GET CHECKOUT LEADS INTERNAL ERROR:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Erro ao buscar leads de checkout",
    });
  }
});

export default router;