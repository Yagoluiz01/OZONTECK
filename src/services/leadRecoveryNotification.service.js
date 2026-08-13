import { supabaseAdmin } from "../config/supabase.js";
import {
  buildIntentProfile,
  INTENT_SIGNAL_EVENT_TYPES,
  getIntelligenceLearningStartAt,
} from "../intelligence/intent.engine.js";
import { buildLeadScore } from "../intelligence/leadScore.engine.js";
import { createAdminNotification } from "./adminNotifications.service.js";

const NOTIFICATION_TYPE = "lead_recovery_ready";
const ADMIN_RECOVERY_EVENT_TYPE = "admin_recovery_started";
const ORDER_CREATED_EVENT_TYPE = "checkout_order_created";
const CHECKOUT_CONTACT_EVENT_TYPE = "checkout_contact";
const DEFAULT_ORDER_DELAY_MINUTES = 5;
const DEFAULT_LOOKBACK_MINUTES = 90;
const INTELLIGENCE_HISTORY_DAYS = 30;
const inflightKeys = new Set();

function normalizeText(value, maxLength = 240) {
  const text = String(value || "").trim().slice(0, Math.max(1, maxLength));
  return text || null;
}

function safeJsonParse(value, fallback = {}) {
  try {
    const parsed = JSON.parse(String(value || ""));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function normalizePhone(value) {
  return String(value || "").replace(/\D/g, "");
}

function isPaidStatus(value) {
  const status = String(value || "").trim().toLowerCase();
  return [
    "paid",
    "pago",
    "approved",
    "aprovado",
    "confirmed",
    "confirmado",
    "completed",
    "complete",
  ].includes(status);
}

function addMinutesIso(value, minutes) {
  const time = Date.parse(value || "");
  if (!Number.isFinite(time)) return null;
  return new Date(time + Math.max(0, Number(minutes || 0)) * 60 * 1000).toISOString();
}

function maxIso(...values) {
  const times = values
    .map((value) => Date.parse(value || ""))
    .filter((value) => Number.isFinite(value));
  return times.length ? new Date(Math.max(...times)).toISOString() : null;
}

function parseOrderEvent(row = {}) {
  const metadata = safeJsonParse(row.section, {});
  return {
    visitor_id: normalizeText(row.visitor_id, 180),
    session_id: normalizeText(row.session_id, 180),
    created_at: row.created_at || null,
    order_number: normalizeText(
      metadata.order_number ||
        metadata.orderNumber ||
        metadata.external_reference ||
        metadata.externalReference,
      180
    ),
    payment_status: normalizeText(metadata.payment_status || metadata.paymentStatus, 80),
  };
}

function parseContactPhone(row = {}) {
  const metadata = safeJsonParse(row.section, {});
  const contact = metadata.contact && typeof metadata.contact === "object" ? metadata.contact : {};
  return normalizePhone(contact.phone_digits || contact.phone);
}

function latestOrderEvents(events = []) {
  const latest = new Map();

  for (const event of events) {
    if (!event?.session_id || !event?.order_number || !event?.created_at) continue;
    const key = `${event.session_id}::${event.order_number}`;
    const current = latest.get(key);
    const eventAt = Date.parse(event.created_at || "");
    const currentAt = Date.parse(current?.created_at || "");

    if (!current || (Number.isFinite(eventAt) && (!Number.isFinite(currentAt) || eventAt > currentAt))) {
      latest.set(key, event);
    }
  }

  return Array.from(latest.values());
}

function behaviorReadyAt(score = {}) {
  const recovery = score?.recovery_priority || {};
  const lastSignalAt = score?.last_signal_at || null;
  const waitMinutes = Math.max(0, Number(recovery.minimum_wait_minutes || 0));
  return waitMinutes > 0 ? addMinutesIso(lastSignalAt, waitMinutes) : lastSignalAt;
}

export function recoveryOpportunityKey(lead = {}) {
  const sessionId = normalizeText(lead.session_id, 180) || "session";
  const orderNumber = normalizeText(lead.order_number, 180) || "order";
  const readyAt = normalizeText(lead.recovery_ready_at, 80) || normalizeText(lead.created_at, 80) || "ready";
  return `${sessionId}::${orderNumber}::${readyAt}`;
}

async function loadKnownOpportunityKeys(lookbackMinutes = DEFAULT_LOOKBACK_MINUTES, nowMs = Date.now()) {
  const sinceIso = new Date(nowMs - Math.max(10, Number(lookbackMinutes || 0)) * 60 * 1000).toISOString();
  const { data, error } = await supabaseAdmin
    .from("admin_notifications")
    .select("metadata, created_at")
    .eq("type", NOTIFICATION_TYPE)
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: false })
    .limit(300);

  if (error) {
    console.error("[LEAD_RECOVERY_NOTIFICATION_LIST_ERROR]", error);
    return new Set();
  }

  return new Set(
    (Array.isArray(data) ? data : [])
      .map((row) => normalizeText(row?.metadata?.opportunity_key, 500))
      .filter(Boolean)
  );
}

export async function notifyRecoveryReadyLeads(leads = [], options = {}) {
  const nowMs = Number(options.nowMs || Date.now());
  const lookbackMinutes = Math.max(10, Number(options.lookbackMinutes || DEFAULT_LOOKBACK_MINUTES));
  const knownKeys = options.knownKeys instanceof Set
    ? options.knownKeys
    : await loadKnownOpportunityKeys(lookbackMinutes, nowMs);

  // Uma notificação de "disponível" só pode nascer após confirmação explícita
  // da mesma inteligência que autoriza a recuperação no painel.
  const candidates = (Array.isArray(leads) ? leads : [])
    .filter((lead) =>
      lead?.is_recoverable === true &&
      lead?.intelligence_ready === true &&
      lead?.order_number &&
      lead?.recovery_status === "payment_pending" &&
      lead?.recovery_ready_at
    )
    .filter((lead) => {
      const readyAtMs = Date.parse(lead.recovery_ready_at || "");
      if (!Number.isFinite(readyAtMs) || readyAtMs > nowMs) return false;
      return (nowMs - readyAtMs) / 60000 <= lookbackMinutes;
    })
    .slice(0, 30);

  let created = 0;

  for (const lead of candidates) {
    const opportunityKey = recoveryOpportunityKey(lead);
    if (knownKeys.has(opportunityKey) || inflightKeys.has(opportunityKey)) continue;
    inflightKeys.add(opportunityKey);

    try {
      const result = await createAdminNotification({
        type: NOTIFICATION_TYPE,
        title: "Recuperação disponível",
        message: "Um pedido pendente está pronto para recuperação na Inteligência de Leads.",
        entity_type: "lead",
        entity_id: null,
        priority: "high",
        metadata: {
          opportunity_key: opportunityKey,
          session_id: lead.session_id || null,
          order_number: lead.order_number || null,
          recovery_ready_at: lead.recovery_ready_at || null,
          intelligence_version: lead.intelligence_version || null,
          lead_score: Number.isFinite(Number(lead.lead_score)) ? Number(lead.lead_score) : null,
          source: "lead_intelligence",
        },
      });

      if (result?.success) {
        created += 1;
        knownKeys.add(opportunityKey);
      }
    } catch (error) {
      // A notificação é auxiliar e nunca pode interromper checkout, pagamento ou a fila.
      console.error("[LEAD_RECOVERY_NOTIFICATION_CREATE_ERROR]", error);
    } finally {
      inflightKeys.delete(opportunityKey);
    }
  }

  return { created, knownKeys };
}

export async function runLeadRecoveryReadyNotificationSweep(options = {}) {
  const nowMs = Number(options.nowMs || Date.now());
  const orderDelayMinutes = Math.max(1, Number(options.orderDelayMinutes || DEFAULT_ORDER_DELAY_MINUTES));
  const lookbackMinutes = Math.max(10, Number(options.lookbackMinutes || DEFAULT_LOOKBACK_MINUTES));
  const limit = Math.min(300, Math.max(1, Number(options.limit || 120)));
  const recentAfterIso = new Date(nowMs - (lookbackMinutes + orderDelayMinutes) * 60 * 1000).toISOString();

  // Importante: consulta também eventos MAIS NOVOS que ainda não venceram o prazo.
  // Só depois de escolher o evento mais recente por pedido/sessão aplicamos a janela.
  // Isso impede um evento antigo duplicado de disparar a notificação prematuramente.
  const { data: orderRows, error: orderError } = await supabaseAdmin
    .from("lead_events")
    .select("id, visitor_id, session_id, event_type, section, created_at")
    .eq("event_type", ORDER_CREATED_EVENT_TYPE)
    .gte("created_at", recentAfterIso)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (orderError) throw orderError;

  const parsedOrderEvents = (Array.isArray(orderRows) ? orderRows : [])
    .map(parseOrderEvent)
    .filter((event) => event.session_id && event.order_number && event.created_at);

  const currentOrderEvents = latestOrderEvents(parsedOrderEvents);
  const orderEvents = currentOrderEvents.filter((event) => {
    const readyAt = Date.parse(addMinutesIso(event.created_at, orderDelayMinutes) || "");
    return Number.isFinite(readyAt) && readyAt <= nowMs;
  });

  if (!orderEvents.length) {
    return { checked: currentOrderEvents.length, eligible: 0, created: 0 };
  }

  const sessionIds = Array.from(new Set(orderEvents.map((event) => event.session_id)));
  const orderNumbers = Array.from(new Set(orderEvents.map((event) => event.order_number)));
  const visitorIds = Array.from(new Set(orderEvents.map((event) => event.visitor_id).filter(Boolean)));
  const learningStartAt = getIntelligenceLearningStartAt();
  const rollingStartAt = new Date(nowMs - INTELLIGENCE_HISTORY_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const intelligenceStartAt = new Date(
    Math.max(Date.parse(rollingStartAt), Date.parse(learningStartAt))
  ).toISOString();

  const intelligenceQuery = visitorIds.length
    ? supabaseAdmin
        .from("lead_events")
        .select("session_id, visitor_id, event_type, page, section, created_at")
        .in("visitor_id", visitorIds)
        .in("event_type", INTENT_SIGNAL_EVENT_TYPES)
        .gte("created_at", intelligenceStartAt)
        .order("created_at", { ascending: true })
        .limit(12000)
    : Promise.resolve({ data: [], error: null });

  const [contactResult, recoveryResult, ordersResult, intelligenceResult, knownKeys] = await Promise.all([
    supabaseAdmin
      .from("lead_events")
      .select("session_id, section, created_at")
      .in("session_id", sessionIds)
      .eq("event_type", CHECKOUT_CONTACT_EVENT_TYPE)
      .order("created_at", { ascending: false })
      .limit(Math.min(sessionIds.length * 4, 600)),
    supabaseAdmin
      .from("lead_events")
      .select("session_id, created_at")
      .in("session_id", sessionIds)
      .eq("event_type", ADMIN_RECOVERY_EVENT_TYPE)
      .order("created_at", { ascending: false })
      .limit(Math.min(sessionIds.length * 3, 500)),
    supabaseAdmin
      .from("orders")
      .select("order_number, payment_status, order_status, created_at")
      .in("order_number", orderNumbers)
      .limit(Math.min(orderNumbers.length, 300)),
    intelligenceQuery,
    loadKnownOpportunityKeys(lookbackMinutes, nowMs),
  ]);

  if (contactResult.error) throw contactResult.error;
  if (recoveryResult.error) throw recoveryResult.error;
  if (ordersResult.error) throw ordersResult.error;
  if (intelligenceResult.error) throw intelligenceResult.error;

  const phoneBySession = new Map();
  for (const row of Array.isArray(contactResult.data) ? contactResult.data : []) {
    if (!row?.session_id || phoneBySession.has(row.session_id)) continue;
    const phone = parseContactPhone(row);
    if (phone) phoneBySession.set(row.session_id, phone);
  }

  const recoveryAtBySession = new Map();
  for (const row of Array.isArray(recoveryResult.data) ? recoveryResult.data : []) {
    if (!row?.session_id || recoveryAtBySession.has(row.session_id)) continue;
    recoveryAtBySession.set(row.session_id, Date.parse(row.created_at || ""));
  }

  const orderByNumber = new Map();
  for (const row of Array.isArray(ordersResult.data) ? ordersResult.data : []) {
    if (row?.order_number) orderByNumber.set(String(row.order_number), row);
  }

  const rowsByVisitor = new Map();
  for (const row of Array.isArray(intelligenceResult.data) ? intelligenceResult.data : []) {
    if (!row?.visitor_id) continue;
    const rows = rowsByVisitor.get(row.visitor_id) || [];
    rows.push(row);
    rowsByVisitor.set(row.visitor_id, rows);
  }

  const notificationLeads = [];

  for (const event of orderEvents) {
    const eventAtMs = Date.parse(event.created_at || "");
    const order = orderByNumber.get(String(event.order_number)) || null;
    const recoveryAtMs = recoveryAtBySession.get(event.session_id) || 0;
    const phone = phoneBySession.get(event.session_id) || "";

    if (!phone) continue;
    if (!event.visitor_id) continue;
    if (isPaidStatus(order?.payment_status) || isPaidStatus(event.payment_status)) continue;
    if (Number.isFinite(recoveryAtMs) && recoveryAtMs >= eventAtMs) continue;

    const visitorRows = rowsByVisitor.get(event.visitor_id) || [];
    if (!visitorRows.some((row) => row?.session_id === event.session_id)) continue;

    const profile = buildIntentProfile(visitorRows, {
      currentSessionId: event.session_id,
      learningStartAt,
    });
    const score = buildLeadScore(profile, { nowMs });
    const recovery = score?.recovery_priority || {};

    // Mesma trava comportamental exibida no painel.
    if (recovery.eligible_by_behavior !== true || recovery.ready_by_behavior !== true) continue;

    const orderReadyAt = addMinutesIso(event.created_at, orderDelayMinutes);
    const intelligenceReadyAt = behaviorReadyAt(score);
    const effectiveReadyAt = maxIso(orderReadyAt, intelligenceReadyAt);
    if (!effectiveReadyAt || Date.parse(effectiveReadyAt) > nowMs) continue;

    notificationLeads.push({
      session_id: event.session_id,
      order_number: event.order_number,
      created_at: event.created_at,
      recovery_ready_at: effectiveReadyAt,
      recovery_status: "payment_pending",
      is_recoverable: true,
      intelligence_ready: true,
      intelligence_version: score.version || null,
      lead_score: Number(score.lead_score || 0),
    });
  }

  const result = await notifyRecoveryReadyLeads(notificationLeads, {
    nowMs,
    lookbackMinutes,
    knownKeys,
  });

  return {
    checked: currentOrderEvents.length,
    eligible: notificationLeads.length,
    created: result.created,
  };
}
