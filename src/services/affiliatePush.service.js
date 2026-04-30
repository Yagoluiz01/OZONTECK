import webpush from "web-push";

const SUPABASE_URL = String(process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || "";

const VAPID_PUBLIC_KEY = process.env.WEB_PUSH_PUBLIC_KEY || process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE_KEY = process.env.WEB_PUSH_PRIVATE_KEY || process.env.VAPID_PRIVATE_KEY || "";
const VAPID_CONTACT_EMAIL = process.env.WEB_PUSH_CONTACT_EMAIL || "suporte@ozonteck.com";

let vapidConfigured = false;

function ensureSupabaseConfig() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Supabase não configurado para notificações.");
  }
}

function ensureVapidConfig() {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    throw new Error("Chaves VAPID não configuradas para notificações.");
  }

  if (!vapidConfigured) {
    webpush.setVapidDetails(
      `mailto:${VAPID_CONTACT_EMAIL}`,
      VAPID_PUBLIC_KEY,
      VAPID_PRIVATE_KEY
    );

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
  const data = text ? JSON.parse(text) : null;

  if (!response.ok) {
    throw new Error(data?.message || data?.error_description || data?.hint || data?.details || "Erro ao consultar Supabase.");
  }

  return data;
}

export function getPublicVapidKey() {
  return VAPID_PUBLIC_KEY;
}

export async function saveAffiliatePushSubscription({ affiliateId, subscription, userAgent = "" }) {
  ensureVapidConfig();

  const payload = {
    affiliate_id: affiliateId,
    endpoint: subscription.endpoint,
    p256dh: subscription.keys?.p256dh,
    auth: subscription.keys?.auth,
    subscription_json: subscription,
    user_agent: String(userAgent || "").slice(0, 500),
    is_active: true,
    last_seen_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const result = await supabaseRequest("/rest/v1/affiliate_push_subscriptions?on_conflict=endpoint", {
    method: "POST",
    headers: {
      Prefer: "resolution=merge-duplicates,return=representation",
    },
    body: JSON.stringify(payload),
  });

  return Array.isArray(result) ? result[0] : result;
}

export async function removeAffiliatePushSubscription({ affiliateId, endpoint }) {
  const query = new URLSearchParams({
    affiliate_id: `eq.${affiliateId}`,
    endpoint: `eq.${endpoint}`,
  });

  return supabaseRequest(`/rest/v1/affiliate_push_subscriptions?${query.toString()}`, {
    method: "PATCH",
    headers: {
      Prefer: "return=minimal",
    },
    body: JSON.stringify({
      is_active: false,
      updated_at: new Date().toISOString(),
    }),
  });
}

export async function sendPushToAffiliate(affiliateId, notification = {}) {
  ensureVapidConfig();

  const query = new URLSearchParams({
    affiliate_id: `eq.${affiliateId}`,
    is_active: "eq.true",
    select: "id,endpoint,p256dh,auth",
  });

  const subscriptions = await supabaseRequest(`/rest/v1/affiliate_push_subscriptions?${query.toString()}`);

  if (!Array.isArray(subscriptions) || subscriptions.length === 0) {
    return { sent: 0, failed: 0, message: "Nenhum aparelho inscrito para este afiliado." };
  }

  let sent = 0;
  let failed = 0;

  const payload = JSON.stringify({
    title: notification.title || "OZONTECK Afiliados",
    body: notification.body || "Você tem uma nova atualização no painel.",
    url: notification.url || "/pages-html/afiliado-painel.html",
    icon: notification.icon || "/assets/images/icons/icon-192.png",
    badge: notification.badge || "/assets/images/icons/icon-192.png",
    data: notification.data || {},
  });

  await Promise.all(subscriptions.map(async (item) => {
    const pushSubscription = {
      endpoint: item.endpoint,
      keys: {
        p256dh: item.p256dh,
        auth: item.auth,
      },
    };

    try {
      await webpush.sendNotification(pushSubscription, payload);
      sent += 1;

      await supabaseRequest(`/rest/v1/affiliate_push_subscriptions?id=eq.${item.id}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          last_sent_at: new Date().toISOString(),
          fail_count: 0,
          updated_at: new Date().toISOString(),
        }),
      });
    } catch (error) {
      failed += 1;
      const shouldDisable = [404, 410].includes(Number(error?.statusCode));

      await supabaseRequest(`/rest/v1/affiliate_push_subscriptions?id=eq.${item.id}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          is_active: shouldDisable ? false : true,
          last_error: String(error?.message || "Erro ao enviar push").slice(0, 500),
          fail_count: shouldDisable ? 99 : 1,
          updated_at: new Date().toISOString(),
        }),
      }).catch(() => null);
    }
  }));

  return { sent, failed };
}
