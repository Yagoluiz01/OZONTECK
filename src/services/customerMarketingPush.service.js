import crypto from "node:crypto";
import webPush from "web-push";

import { supabaseAdmin } from "../config/supabase.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const VAPID_PUBLIC_KEY =
  process.env.WEB_PUSH_PUBLIC_KEY || process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE_KEY =
  process.env.WEB_PUSH_PRIVATE_KEY || process.env.VAPID_PRIVATE_KEY || "";
const VAPID_SUBJECT = normalizeVapidSubject(
  process.env.WEB_PUSH_CONTACT_EMAIL ||
    process.env.VAPID_SUBJECT ||
    "mailto:ozonteck14@gmail.com"
);

function cleanText(value, maxLength = 500) {
  const text = String(value || "").trim();
  return text ? text.slice(0, maxLength) : "";
}

function getBaseUrl(value) {
  return cleanText(value, 1000).replace(/\/+$/, "");
}

function resolvePublicUrl(value, baseUrl = "") {
  const rawValue = cleanText(value, 1000);
  if (!rawValue) return "";

  try {
    const safeBaseUrl = getBaseUrl(baseUrl);
    const resolved = safeBaseUrl
      ? new URL(rawValue, `${safeBaseUrl}/`)
      : new URL(rawValue);

    return ["http:", "https:"].includes(resolved.protocol) ? resolved.toString() : "";
  } catch {
    return rawValue.startsWith("/") && !rawValue.startsWith("//") ? rawValue : "";
  }
}

function normalizeVapidSubject(value) {
  const subject = String(value || "").trim();
  if (!subject) return "mailto:ozonteck14@gmail.com";
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(subject)) return `mailto:${subject}`;
  return subject;
}

function isAllowedWebPushHost(hostname) {
  const host = String(hostname || "").trim().toLowerCase();
  const allowedSuffixes = [
    "fcm.googleapis.com",
    "android.googleapis.com",
    "push.services.mozilla.com",
    "web.push.apple.com",
    "notify.windows.com",
  ];

  return allowedSuffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

function ensureVapidConfig() {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    return { configured: false, reason: "web_push_not_configured" };
  }

  return {
    configured: true,
    reason: null,
    details: {
      subject: VAPID_SUBJECT,
      publicKey: VAPID_PUBLIC_KEY,
      privateKey: VAPID_PRIVATE_KEY,
    },
  };
}

function normalizeSubscription(subscription = {}) {
  const endpoint = cleanText(subscription?.endpoint, 2048);
  // O navegador envia `keys`; o worker lê as mesmas chaves nas colunas
  // protegidas da tabela. Ambos representam a mesma inscrição Web Push.
  const p256dh = cleanText(
    subscription?.keys?.p256dh || subscription?.p256dh,
    1024
  );
  const auth = cleanText(subscription?.keys?.auth || subscription?.auth, 1024);

  if (!endpoint || !p256dh || !auth) {
    const error = new Error("Inscrição Web Push inválida.");
    error.statusCode = 400;
    error.code = "invalid_web_push_subscription";
    throw error;
  }

  if (
    !/^[A-Za-z0-9_-]{40,200}={0,2}$/.test(p256dh) ||
    !/^[A-Za-z0-9_-]{10,200}={0,2}$/.test(auth)
  ) {
    const error = new Error("Chaves da inscrição Web Push inválidas.");
    error.statusCode = 400;
    error.code = "invalid_web_push_keys";
    throw error;
  }

  let parsedEndpoint;
  try {
    parsedEndpoint = new URL(endpoint);
  } catch {
    parsedEndpoint = null;
  }

  if (
    !parsedEndpoint ||
    parsedEndpoint.protocol !== "https:" ||
    !isAllowedWebPushHost(parsedEndpoint.hostname)
  ) {
    const error = new Error("Endpoint Web Push inválido.");
    error.statusCode = 400;
    error.code = "invalid_web_push_endpoint";
    throw error;
  }

  return {
    endpoint,
    p256dh,
    auth,
  };
}

function endpointHash(endpoint) {
  return crypto.createHash("sha256").update(endpoint).digest("hex");
}

export function buildMarketingPushRecipientKey({ customerId, visitorId } = {}) {
  const safeCustomerId = cleanText(customerId, 80);
  if (UUID_PATTERN.test(safeCustomerId)) return `customer:${safeCustomerId.toLowerCase()}`;

  const safeVisitorId = cleanText(visitorId, 180);
  if (!safeVisitorId) return "";
  return `visitor:${crypto.createHash("sha256").update(safeVisitorId).digest("hex")}`;
}

function isGonePushEndpoint(error) {
  const statusCode = Number(error?.statusCode || error?.status || 0);
  return statusCode === 404 || statusCode === 410;
}

export function getCustomerMarketingPushPublicKey() {
  return VAPID_PUBLIC_KEY;
}

export function buildProductInterestPushPayload({
  product,
  productUrl,
  campaignId,
  brandName,
  brandIconUrl,
  brandBadgeUrl,
  storefrontUrl,
} = {}) {
  const safeStorefrontUrl = getBaseUrl(
    storefrontUrl || process.env.STORE_FRONTEND_URL || process.env.FRONTEND_URL
  );
  const safeBrandName =
    cleanText(brandName || process.env.PRODUCT_INTEREST_BRAND_NAME, 80) ||
    "levra_perfume";
  const productName =
    cleanText(product?.name, 180) || `Novidade da ${safeBrandName}`;
  const category = cleanText(product?.category, 120);
  const image = resolvePublicUrl(
    product?.image_card_url || product?.image_thumb_url || product?.image_url,
    safeStorefrontUrl
  );
  const icon = resolvePublicUrl(
    brandIconUrl ||
      process.env.PRODUCT_INTEREST_BRAND_ICON_URL ||
      "/assets/images/brand/store/icon-192.png",
    safeStorefrontUrl
  );
  const badge = resolvePublicUrl(
    brandBadgeUrl ||
      process.env.PRODUCT_INTEREST_BRAND_BADGE_URL ||
      "/assets/images/brand/store/icon-192.png",
    safeStorefrontUrl
  );

  return {
    title: productName,
    body: category
      ? `Novo em ${category} na ${safeBrandName}. Toque para conhecer ${productName}.`
      : `${productName} acabou de chegar na ${safeBrandName}. Toque para conhecer.`,
    url: resolvePublicUrl(productUrl, safeStorefrontUrl) || "/",
    icon,
    badge: badge || icon,
    ...(image ? { image } : {}),
    data: {
      type: "product_interest",
      product_id: product?.id || null,
      campaign_id: campaignId || null,
      brand: safeBrandName,
    },
  };
}

export function buildMarketingCampaignPushPayload({
  title,
  body,
  url,
  imageUrl,
  iconUrl,
  badgeUrl,
  campaignId,
  campaignType,
  storefrontUrl,
} = {}) {
  const safeStorefrontUrl = getBaseUrl(
    storefrontUrl || process.env.STORE_FRONTEND_URL || process.env.FRONTEND_URL
  );
  const icon = resolvePublicUrl(
    iconUrl ||
      process.env.PRODUCT_INTEREST_BRAND_ICON_URL ||
      "/assets/images/brand/store/icon-192.png",
    safeStorefrontUrl
  );
  const badge = resolvePublicUrl(
    badgeUrl ||
      process.env.PRODUCT_INTEREST_BRAND_BADGE_URL ||
      "/assets/images/brand/store/icon-192.png",
    safeStorefrontUrl
  );
  const image = resolvePublicUrl(imageUrl, safeStorefrontUrl);

  return {
    title: cleanText(title, 120) || "Novidade da Levra",
    body: cleanText(body, 360) || "Tem novidade esperando por você.",
    url: resolvePublicUrl(url, safeStorefrontUrl) || safeStorefrontUrl || "/",
    icon,
    badge: badge || icon,
    ...(image ? { image } : {}),
    data: {
      type: "marketing_campaign",
      campaign_id: cleanText(campaignId, 80) || null,
      campaign_type: cleanText(campaignType, 60) || null,
    },
  };
}

export async function sendMarketingPushSubscription(
  { subscription, payload, ttlSeconds = 60 * 60 } = {},
  { client = supabaseAdmin, sender = webPush.sendNotification.bind(webPush) } = {}
) {
  let vapid;
  try {
    vapid = ensureVapidConfig();
  } catch (error) {
    return {
      success: false,
      skipped: true,
      stale: false,
      reason: "web_push_configuration_invalid",
      error: cleanText(error?.message, 500),
    };
  }

  if (!vapid.configured) {
    return {
      success: false,
      skipped: true,
      stale: false,
      reason: vapid.reason,
    };
  }

  const subscriptionId = cleanText(subscription?.id, 80);
  if (!UUID_PATTERN.test(subscriptionId)) {
    return {
      success: false,
      skipped: true,
      stale: false,
      reason: "invalid_push_subscription_id",
    };
  }

  let normalized;
  try {
    normalized = normalizeSubscription(subscription);
  } catch (error) {
    return {
      success: false,
      skipped: true,
      stale: false,
      reason: error?.code || "invalid_web_push_subscription",
      error: cleanText(error?.message, 500),
    };
  }

  const serializedPayload =
    typeof payload === "string" ? payload : JSON.stringify(payload || {});
  const now = new Date().toISOString();

  let providerResponse;
  try {
    providerResponse = await sender(
      {
        endpoint: normalized.endpoint,
        keys: { p256dh: normalized.p256dh, auth: normalized.auth },
      },
      serializedPayload,
      {
        TTL: Math.max(60, Math.min(24 * 60 * 60, Number(ttlSeconds) || 3600)),
        urgency: "normal",
        vapidDetails: vapid.details,
      }
    );
  } catch (error) {
    const stale = isGonePushEndpoint(error);
    const failureReason = cleanText(error?.message || "Falha Web Push", 500);
    const nextFailCount = stale
      ? 99
      : Math.min(98, Number(subscription?.fail_count || 0) + 1);

    const { error: updateError } = await client
      .from("customer_marketing_push_subscriptions")
      .update({
        is_active: stale ? false : true,
        revoked_at: stale ? now : null,
        fail_count: nextFailCount,
        last_error: failureReason,
        updated_at: now,
      })
      .eq("id", subscriptionId);

    if (updateError) {
      console.error("MARKETING PUSH SUBSCRIPTION UPDATE ERROR:", {
        subscriptionId,
        message: updateError.message,
      });
    }

    return {
      success: false,
      skipped: false,
      stale,
      reason: stale ? "stale_push_subscription" : "web_push_send_failed",
      error: failureReason,
      providerStatusCode: Number(error?.statusCode || error?.status || 0) || null,
    };
  }

  // A aceitação pelo provedor é o fato de entrega mais importante. Uma falha
  // posterior ao atualizar telemetria não deve transformar esse aceite em
  // falha nem provocar um segundo envio no retry do job.
  const { error: updateError } = await client
    .from("customer_marketing_push_subscriptions")
    .update({
      last_sent_at: now,
      fail_count: 0,
      last_error: null,
      updated_at: now,
    })
    .eq("id", subscriptionId);

  if (updateError) {
    console.error("MARKETING PUSH SUBSCRIPTION METRICS UPDATE ERROR:", {
      subscriptionId,
      message: updateError.message,
    });
  }

  return {
    success: true,
    skipped: false,
    stale: false,
    reason: null,
    providerStatusCode: Number(providerResponse?.statusCode || 201),
    providerMessageId:
      cleanText(providerResponse?.headers?.location, 500) || null,
    telemetryUpdated: !updateError,
  };
}

export async function saveCustomerMarketingPushSubscription(
  {
    customerId,
    visitorId,
    sessionId,
    subscription,
    userAgent = "",
    marketingConsent = false,
  } = {},
  { client = supabaseAdmin } = {}
) {
  const safeCustomerId = cleanText(customerId, 80);
  const customerIsValid = UUID_PATTERN.test(safeCustomerId);
  const safeVisitorId = cleanText(visitorId, 180);
  const safeSessionId = cleanText(sessionId, 180);
  if (!customerIsValid && !safeVisitorId) {
    const error = new Error("Visitante ou cliente inválido para inscrição Web Push.");
    error.statusCode = 400;
    throw error;
  }
  const normalized = normalizeSubscription(subscription);
  const normalizedEndpointHash = endpointHash(normalized.endpoint);
  const now = new Date().toISOString();
  const { data: existing, error: existingError } = await client
    .from("customer_marketing_push_subscriptions")
    .select("id,customer_id,visitor_id,p256dh,auth")
    .eq("endpoint_hash", normalizedEndpointHash)
    .maybeSingle();
  if (existingError) throw existingError;
  if (
    existing?.id &&
    (existing.p256dh !== normalized.p256dh || existing.auth !== normalized.auth)
  ) {
    const error = new Error("A inscrição Web Push não corresponde a este navegador.");
    error.statusCode = 409;
    error.code = "web_push_subscription_ownership_mismatch";
    throw error;
  }

  // Um POST anônimo jamais remove o vínculo autenticado já existente.
  const ownerCustomerId = customerIsValid
    ? safeCustomerId
    : UUID_PATTERN.test(cleanText(existing?.customer_id, 80))
      ? cleanText(existing.customer_id, 80)
      : null;
  const ownerVisitorId = safeVisitorId || cleanText(existing?.visitor_id, 180) || null;
  let isSuppressed = false;

  if (marketingConsent === true && customerIsValid) {
    const { error: consentError } = await client
      .from("customer_marketing_suppressions")
      .delete()
      .eq("customer_id", ownerCustomerId)
      .eq("channel", "web_push");
    if (consentError) throw consentError;
  } else if (ownerCustomerId) {
    const { data: suppression, error: suppressionLookupError } = await client
      .from("customer_marketing_suppressions")
      .select("customer_id")
      .eq("customer_id", ownerCustomerId)
      .eq("channel", "web_push")
      .maybeSingle();
    if (suppressionLookupError) throw suppressionLookupError;
    isSuppressed = Boolean(suppression?.customer_id);
  }

  const { data, error } = await client
    .from("customer_marketing_push_subscriptions")
    .upsert(
      {
        customer_id: ownerCustomerId,
        visitor_id: ownerVisitorId,
        last_session_id: safeSessionId || null,
        endpoint: normalized.endpoint,
        endpoint_hash: normalizedEndpointHash,
        p256dh: normalized.p256dh,
        auth: normalized.auth,
        user_agent: cleanText(userAgent, 500) || null,
        is_active: !isSuppressed,
        consented_at: now,
        revoked_at: isSuppressed ? now : null,
        last_seen_at: now,
        fail_count: 0,
        last_error: null,
        updated_at: now,
      },
      { onConflict: "endpoint_hash" }
    )
    .select("id,customer_id,visitor_id,is_active,consented_at,last_seen_at")
    .single();

  if (error) throw error;

  return data;
}

export async function deactivateCustomerMarketingPushSubscription(
  { customerId, visitorId, endpoint, reason = "customer_unsubscribe" } = {},
  { client = supabaseAdmin } = {}
) {
  const safeCustomerId = cleanText(customerId, 80);
  const customerIsValid = UUID_PATTERN.test(safeCustomerId);
  const safeVisitorId = cleanText(visitorId, 180);
  const safeEndpoint = cleanText(endpoint, 2048);
  if ((!customerIsValid && !safeVisitorId) || !safeEndpoint) {
    const error = new Error("Visitante ou cliente e endpoint são obrigatórios.");
    error.statusCode = 400;
    throw error;
  }

  const now = new Date().toISOString();
  let deactivateQuery = client
    .from("customer_marketing_push_subscriptions")
    .update({
      is_active: false,
      revoked_at: now,
      last_error: cleanText(reason, 500) || "customer_unsubscribe",
      updated_at: now,
    })
    .eq("endpoint_hash", endpointHash(safeEndpoint));
  deactivateQuery = customerIsValid
    ? deactivateQuery.eq("customer_id", safeCustomerId)
    : deactivateQuery.eq("visitor_id", safeVisitorId);
  const { error } = await deactivateQuery;
  if (error) throw error;

  if (customerIsValid) {
    const { error: suppressionError } = await client
      .from("customer_marketing_suppressions")
      .upsert(
        {
          customer_id: safeCustomerId,
          channel: "web_push",
          reason: cleanText(reason, 120) || "customer_unsubscribe",
          suppressed_at: now,
          updated_at: now,
        },
        { onConflict: "customer_id,channel" }
      );
    if (suppressionError) throw suppressionError;
  }

  return {
    customerId: customerIsValid ? safeCustomerId : null,
    visitorId: safeVisitorId || null,
    channel: "web_push",
    suppressed: true,
  };
}

export async function sendCustomerMarketingPush(
  {
    customerId,
    visitorId,
    product,
    productUrl,
    campaignId,
    brandName,
    brandIconUrl,
    brandBadgeUrl,
    storefrontUrl,
  } = {},
  { client = supabaseAdmin, sender = webPush.sendNotification.bind(webPush) } = {}
) {
  let vapid;
  try {
    vapid = ensureVapidConfig();
  } catch (error) {
    return {
      success: false,
      skipped: true,
      reason: "web_push_configuration_invalid",
      error: cleanText(error?.message, 500),
    };
  }

  if (!vapid.configured) {
    return { success: false, skipped: true, reason: vapid.reason };
  }

  const safeCustomerId = cleanText(customerId, 80);
  const customerIsValid = UUID_PATTERN.test(safeCustomerId);
  const safeVisitorId = cleanText(visitorId, 180);
  if (!customerIsValid && !safeVisitorId) {
    return { success: false, skipped: true, reason: "invalid_push_recipient" };
  }

  let subscriptionQuery = client
    .from("customer_marketing_push_subscriptions")
    .select("id,endpoint,p256dh,auth,fail_count")
    .eq("is_active", true)
    .order("last_seen_at", { ascending: false });
  subscriptionQuery = customerIsValid
    ? subscriptionQuery.eq("customer_id", safeCustomerId)
    : subscriptionQuery.eq("visitor_id", safeVisitorId).is("customer_id", null);
  const { data: subscriptions, error } = await subscriptionQuery.limit(10);
  if (error) throw error;

  if (!subscriptions?.length) {
    return { success: false, skipped: true, reason: "no_active_push_subscription" };
  }

  const payload = JSON.stringify(
    buildProductInterestPushPayload({
      product,
      productUrl,
      campaignId,
      brandName,
      brandIconUrl,
      brandBadgeUrl,
      storefrontUrl,
    })
  );
  let sent = 0;
  let failed = 0;

  await Promise.all(
    subscriptions.map(async (item) => {
      try {
        await sender(
          {
            endpoint: item.endpoint,
            keys: { p256dh: item.p256dh, auth: item.auth },
          },
          payload,
          {
            TTL: 60 * 60,
            urgency: "normal",
            vapidDetails: vapid.details,
          }
        );
      } catch (pushError) {
        failed += 1;
        const disable = isGonePushEndpoint(pushError);
        const now = new Date().toISOString();
        await client
          .from("customer_marketing_push_subscriptions")
          .update({
            is_active: disable ? false : true,
            revoked_at: disable ? now : null,
            fail_count: disable ? 99 : Math.min(98, Number(item.fail_count || 0) + 1),
            last_error: cleanText(pushError?.message || "Falha Web Push", 500),
            updated_at: now,
          })
          .eq("id", item.id);
        return;
      }

      sent += 1;
      const now = new Date().toISOString();
      try {
        const { error: metricsError } = await client
          .from("customer_marketing_push_subscriptions")
          .update({
            last_sent_at: now,
            fail_count: 0,
            last_error: null,
            updated_at: now,
          })
          .eq("id", item.id);
        if (metricsError) throw metricsError;
      } catch (metricsError) {
        console.error("CUSTOMER MARKETING PUSH METRICS UPDATE ERROR:", {
          subscriptionId: item.id,
          message: metricsError?.message || String(metricsError),
        });
      }
    })
  );

  return {
    success: sent > 0,
    skipped: false,
    reason: sent > 0 ? null : "web_push_send_failed",
    sentCount: sent,
    failedCount: failed,
  };
}
