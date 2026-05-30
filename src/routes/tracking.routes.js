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


const CHECKOUT_RECOVERY_DELAY_MINUTES = 15;
const ORDER_RECOVERY_DELAY_MINUTES = 30;
const RECOVERY_ORDER_EVENT_TYPES = [
  "checkout_order_created",
  "checkout_payment_confirmed",
  "payment_success",
  "purchase",
];

function clampMinutes(value, fallback, max = 24 * 60) {
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes < 0) return fallback;
  return Math.min(Math.floor(minutes), max);
}

function addMinutesIso(value, minutes) {
  const time = Date.parse(value || "");
  if (!Number.isFinite(time)) return null;
  return new Date(time + minutes * 60 * 1000).toISOString();
}

function secondsUntil(value, nowMs = Date.now()) {
  const time = Date.parse(value || "");
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


router.post("/checkout-contact", async (req, res) => {
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
        details: ensuredSession.details || ensuredSession.message,
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

    const { data, error } = await supabase
      .from("lead_events")
      .insert([eventPayload])
      .select("*")
      .single();

    if (error) {
      console.error("TRACKING CHECKOUT CONTACT ERROR:", error);
      return res.status(500).json({
        success: false,
        message: error.message,
        details: error,
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


router.get("/checkout-leads", async (req, res) => {
  try {
    const dateFrom = normalizeText(req.query.date_from);
    const dateTo = normalizeText(req.query.date_to);
    const limit = toPositiveInt(req.query.limit, 200);
    const checkoutDelayMinutes = clampMinutes(
      req.query.recovery_delay_minutes,
      CHECKOUT_RECOVERY_DELAY_MINUTES
    );
    const orderDelayMinutes = clampMinutes(
      req.query.order_recovery_delay_minutes,
      ORDER_RECOVERY_DELAY_MINUTES
    );

    let query = supabase
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
      const { data: orderEvents, error: orderEventsError } = await supabase
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

    const orderNumbers = Array.from(latestOrderEventBySession.values())
      .map((event) => event.order_number)
      .filter(Boolean);
    const orderByNumber = new Map();

    if (orderNumbers.length) {
      const { data: orders, error: ordersError } = await supabase
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
    const leads = groupedLeads
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

    return res.status(200).json({
      success: true,
      meta: {
        checkout_recovery_delay_minutes: checkoutDelayMinutes,
        order_recovery_delay_minutes: orderDelayMinutes,
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