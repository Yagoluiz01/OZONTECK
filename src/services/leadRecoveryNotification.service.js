import { supabaseAdmin } from "../config/supabase.js";
import { createAdminNotification } from "./adminNotifications.service.js";

const NOTIFICATION_TYPE = "lead_recovery_ready";
const ADMIN_RECOVERY_EVENT_TYPE = "admin_recovery_started";
const ORDER_CREATED_EVENT_TYPE = "checkout_order_created";
const CHECKOUT_CONTACT_EVENT_TYPE = "checkout_contact";
const DEFAULT_ORDER_DELAY_MINUTES = 10;
const DEFAULT_LOOKBACK_MINUTES = 90;
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

function parseOrderEvent(row = {}) {
  const metadata = safeJsonParse(row.section, {});
  return {
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

  const candidates = (Array.isArray(leads) ? leads : [])
    .filter((lead) =>
      lead?.is_recoverable === true &&
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
  const limit = Math.min(200, Math.max(1, Number(options.limit || 80)));
  const readyBeforeIso = new Date(nowMs - orderDelayMinutes * 60 * 1000).toISOString();
  const recentAfterIso = new Date(nowMs - (lookbackMinutes + orderDelayMinutes) * 60 * 1000).toISOString();

  const { data: orderRows, error: orderError } = await supabaseAdmin
    .from("lead_events")
    .select("id, session_id, event_type, section, created_at")
    .eq("event_type", ORDER_CREATED_EVENT_TYPE)
    .gte("created_at", recentAfterIso)
    .lte("created_at", readyBeforeIso)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (orderError) throw orderError;

  const orderEvents = (Array.isArray(orderRows) ? orderRows : [])
    .map(parseOrderEvent)
    .filter((event) => event.session_id && event.order_number && event.created_at);

  if (!orderEvents.length) {
    return { checked: 0, eligible: 0, created: 0 };
  }

  const sessionIds = Array.from(new Set(orderEvents.map((event) => event.session_id)));
  const orderNumbers = Array.from(new Set(orderEvents.map((event) => event.order_number));

  const [contactResult, recoveryResult, ordersResult, knownKeys] = await Promise.all([
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
    loadKnownOpportunityKeys(lookbackMinutes, nowMs),
  ]);

  if (contactResult.error) throw contactResult.error;
  if (recoveryResult.error) throw recoveryResult.error;
  if (ordersResult.error) throw ordersResult.error;

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

  const notificationLeads = [];

  for (const event of orderEvents) {
    const eventAtMs = Date.parse(event.created_at || "");
    const order = orderByNumber.get(String(event.order_number)) || null;
    const recoveryAtMs = recoveryAtBySession.get(event.session_id) || 0;
    const phone = phoneBySession.get(event.session_id) || "";

    if (!phone) continue;
    if (isPaidStatus(order?.payment_status) || isPaidStatus(event.payment_status)) continue;
    if (Number.isFinite(recoveryAtMs) && recoveryAtMs >= eventAtMs) continue;

    notificationLeads.push({
      session_id: event.session_id,
      order_number: event.order_number,
      created_at: event.created_at,
      recovery_ready_at: addMinutesIso(event.created_at, orderDelayMinutes),
      recovery_status: "payment_pending",
      is_recoverable: true,
    });
  }

  const result = await notifyRecoveryReadyLeads(notificationLeads, {
    nowMs,
    lookbackMinutes,
    knownKeys,
  });

  return {
    checked: orderEvents.length,
    eligible: notificationLeads.length,
    created: result.created,
  };
}
