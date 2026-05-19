import webPush from "web-push";

const SUPABASE_URL = String(process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || "";

const VAPID_PUBLIC_KEY =
  process.env.WEB_PUSH_PUBLIC_KEY || process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE_KEY =
  process.env.WEB_PUSH_PRIVATE_KEY || process.env.VAPID_PRIVATE_KEY || "";
const VAPID_SUBJECT =
  process.env.WEB_PUSH_CONTACT_EMAIL ||
  process.env.VAPID_SUBJECT ||
  "mailto:ozonteck14@gmail.com";

let vapidConfigured = false;

function ensureSupabaseConfig() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Supabase não configurado para notificações do cliente.");
  }
}

function ensureVapidConfig() {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    throw new Error("Chaves VAPID não configuradas para notificações do cliente.");
  }

  if (!vapidConfigured) {
    webPush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
    vapidConfigured = true;
  }
}

function supabaseHeaders(extra = {}) {
  ensureSupabaseConfig();

  return {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

async function supabaseRequest(path, options = {}) {
  ensureSupabaseConfig();

  const response = await fetch(`${SUPABASE_URL}${path}`, {
    ...options,
    headers: {
      ...supabaseHeaders(),
      ...(options.headers || {}),
    },
  });

  const text = await response.text();
  let data = null;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!response.ok) {
    throw new Error(
      data?.message ||
        data?.error_description ||
        data?.hint ||
        data?.details ||
        "Erro ao consultar Supabase."
    );
  }

  return data;
}

function sanitizeOrderNumber(value) {
  return String(value || "").trim().slice(0, 80);
}

function buildTrackingUrl(order = {}) {
  return String(
    order.shipping_tracking_url ||
      order.tracking_url ||
      order.shipping_label_url ||
      order.shipping_label_pdf_url ||
      ""
  ).trim();
}

function buildOrderNotificationUrl(order = {}) {
  const orderNumber = sanitizeOrderNumber(order.order_number || order.orderNumber);
  const baseUrl = String(process.env.STORE_FRONTEND_URL || process.env.FRONTEND_URL || "").replace(/\/+$/, "");
  const path = `/pages-html/pagamento-sucesso.html${orderNumber ? `?pedido=${encodeURIComponent(orderNumber)}` : ""}`;

  return baseUrl ? `${baseUrl}${path}` : path;
}

function normalizeCarrierName(value) {
  const carrier = String(value || "").trim();

  if (!carrier) return "Jadlog";

  if (carrier.toLowerCase().includes("jadlog")) {
    return "Jadlog";
  }

  return carrier;
}

function isFreshTrackingReservation(value, maxAgeMs = 2 * 60 * 1000) {
  if (!value) return false;

  const reservedAt = new Date(value).getTime();

  if (!Number.isFinite(reservedAt)) return false;

  return Date.now() - reservedAt < maxAgeMs;
}

export function getCustomerOrderPushPublicKey() {
  return VAPID_PUBLIC_KEY;
}

export async function saveCustomerOrderPushSubscription({
  orderNumber,
  paymentId = "",
  subscription,
  userAgent = "",
}) {
  ensureVapidConfig();

  const cleanOrderNumber = sanitizeOrderNumber(orderNumber);

  if (!cleanOrderNumber) {
    throw new Error("Número do pedido é obrigatório para ativar notificações.");
  }

  if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    throw new Error("Inscrição de notificação inválida.");
  }

  const payload = {
    order_number: cleanOrderNumber,
    payment_id: String(paymentId || "").trim().slice(0, 120),
    endpoint: subscription.endpoint,
    p256dh: subscription.keys.p256dh,
    auth: subscription.keys.auth,
    subscription_json: subscription,
    user_agent: String(userAgent || "").slice(0, 500),
    is_active: true,
    last_seen_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const result = await supabaseRequest(
    "/rest/v1/customer_order_push_subscriptions?on_conflict=endpoint",
    {
      method: "POST",
      headers: {
        Prefer: "resolution=merge-duplicates,return=representation",
      },
      body: JSON.stringify(payload),
    }
  );

  return Array.isArray(result) ? result[0] : result;
}

export async function sendCustomerOrderPush(order = {}, notification = {}) {
  ensureVapidConfig();

  const orderNumber = sanitizeOrderNumber(order.order_number || order.orderNumber);

  if (!orderNumber) {
    return {
      sent: 0,
      failed: 0,
      skipped: true,
      reason: "missing_order_number",
    };
  }

  const isTrackingNotification =
    String(notification.type || "").trim() === "tracking_available";

  const query = new URLSearchParams({
    order_number: `eq.${orderNumber}`,
    is_active: "eq.true",
    select: "id,endpoint,p256dh,auth,last_sent_at,last_tracking_sent_at",
  });

  const subscriptions = await supabaseRequest(
    `/rest/v1/customer_order_push_subscriptions?${query.toString()}`
  );

  if (!Array.isArray(subscriptions) || subscriptions.length === 0) {
    return {
      sent: 0,
      failed: 0,
      skipped: true,
      reason: "no_customer_subscriptions",
    };
  }

  const trackingCode = String(
    order.shipping_tracking_code || order.tracking_code || order.trackingCode || ""
  ).trim();
  const trackingUrl = buildTrackingUrl(order);

  const payload = JSON.stringify({
    title: notification.title || "Atualização do seu pedido OZONTECK",
    body:
      notification.body ||
      (trackingCode
        ? `Seu pedido ${orderNumber} já tem rastreio: ${trackingCode}.`
        : `Seu pedido ${orderNumber} recebeu uma nova atualização.`),
    url: notification.url || buildOrderNotificationUrl(order),
    icon: notification.icon || "/assets/images/icons/icon-192.png",
    badge: notification.badge || "/assets/images/icons/icon-192.png",
    data: {
      type: notification.type || "order_update",
      order_number: orderNumber,
      tracking_code: trackingCode,
      tracking_url: trackingUrl,
      ...(notification.data || {}),
    },
  });

  let sent = 0;
  let failed = 0;
  let skipped = 0;

  await Promise.all(
    subscriptions.map(async (item) => {
      let reservedTrackingAt = null;

      if (isTrackingNotification && item.last_sent_at && item.last_tracking_sent_at) {
        skipped += 1;
        return;
      }

      if (
        isTrackingNotification &&
        !item.last_sent_at &&
        item.last_tracking_sent_at &&
        isFreshTrackingReservation(item.last_tracking_sent_at)
      ) {
        skipped += 1;
        return;
      }

      if (isTrackingNotification) {
        reservedTrackingAt = new Date().toISOString();

        const reserveQuery = new URLSearchParams({
          id: `eq.${item.id}`,
          last_sent_at: "is.null",
        });

        const reserved = await supabaseRequest(
          `/rest/v1/customer_order_push_subscriptions?${reserveQuery.toString()}`,
          {
            method: "PATCH",
            headers: { Prefer: "return=representation" },
            body: JSON.stringify({
              last_tracking_sent_at: reservedTrackingAt,
              last_error: null,
              updated_at: reservedTrackingAt,
            }),
          }
        ).catch(() => []);

        if (!Array.isArray(reserved) || reserved.length === 0) {
          skipped += 1;
          return;
        }
      }

      try {
        await webPush.sendNotification(
          {
            endpoint: item.endpoint,
            keys: {
              p256dh: item.p256dh,
              auth: item.auth,
            },
          },
          payload
        );

        sent += 1;

        const now = new Date().toISOString();

        await supabaseRequest(
          `/rest/v1/customer_order_push_subscriptions?id=eq.${item.id}`,
          {
            method: "PATCH",
            headers: { Prefer: "return=minimal" },
            body: JSON.stringify({
              last_sent_at: now,
              ...(isTrackingNotification ? { last_tracking_sent_at: now } : {}),
              fail_count: 0,
              last_error: null,
              updated_at: now,
            }),
          }
        ).catch(() => null);
      } catch (error) {
        failed += 1;
        const statusCode = Number(error?.statusCode || 0);
        const shouldDisable = statusCode === 404 || statusCode === 410;

        const failurePayload = {
          is_active: shouldDisable ? false : true,
          last_error: String(error?.message || "Erro ao enviar push").slice(0, 500),
          fail_count: shouldDisable ? 99 : 1,
          updated_at: new Date().toISOString(),
        };

        if (isTrackingNotification) {
          failurePayload.last_tracking_sent_at = null;
        }

        await supabaseRequest(
          `/rest/v1/customer_order_push_subscriptions?id=eq.${item.id}`,
          {
            method: "PATCH",
            headers: { Prefer: "return=minimal" },
            body: JSON.stringify(failurePayload),
          }
        ).catch(() => null);
      }
    })
  );

  return {
    sent,
    failed,
    skipped,
    skipped_duplicates: skipped,
  };
}

export async function sendCustomerOrderPushForPaymentApproved(order = {}) {
  return sendCustomerOrderPush(order, {
    type: "order_paid",
    title: "✅ Pagamento confirmado",
    body: `Recebemos o pagamento do pedido ${order.order_number || ""}. Agora vamos preparar o envio.`,
  });
}

export async function sendCustomerOrderPushForTracking(order = {}) {
  const orderNumber = sanitizeOrderNumber(order.order_number || order.orderNumber);
  const trackingCode = String(order.shipping_tracking_code || order.tracking_code || "").trim();
  const carrier = normalizeCarrierName(order.shipping_carrier || order.shipping_service_name || "Jadlog");

  return sendCustomerOrderPush(order, {
    type: "tracking_available",
    title: `📦 Pedido enviado para a ${carrier}`,
    body: trackingCode
      ? `Seu pedido ${orderNumber} foi enviado para a ${carrier}. Código de rastreio: ${trackingCode}.`
      : `Seu pedido ${orderNumber} foi enviado para a ${carrier}. Em breve o rastreio estará disponível.`,
    data: {
      carrier,
    },
  });
}
