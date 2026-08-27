import jwt from "jsonwebtoken";

import { env } from "../config/env.js";
import { supabaseAdmin } from "../config/supabase.js";
import { normalizeInterestCategory } from "../intelligence/interestTaxonomy.js";
import {
  evaluateInterestEligibility,
  refreshCustomerInterestProfilesBatch,
  refreshVisitorInterestProfile,
  refreshVisitorInterestProfilesBatch,
} from "./customerInterestProfile.service.js";
import {
  buildMarketingPushRecipientKey,
  sendCustomerMarketingPush,
} from "./customerMarketingPush.service.js";
import { sendSmtpEmail } from "./emailTransport.service.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const WORKER_ID = `product-interest-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;

function isTruthy(value) {
  return ["1", "true", "yes", "sim", "on"].includes(
    String(value || "").trim().toLowerCase()
  );
}

function clampInt(value, min, max, fallback) {
  const number = Math.trunc(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function cleanText(value, maxLength = 500) {
  const text = String(value || "").trim();
  return text ? text.slice(0, maxLength) : "";
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

function getBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
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

export function getProductInterestNotificationConfig(overrides = {}) {
  const emailEnabled =
    overrides.emailEnabled ??
    isTruthy(process.env.PRODUCT_INTEREST_EMAIL_ENABLED || "true");
  const webPushEnabled =
    overrides.webPushEnabled ??
    isTruthy(process.env.PRODUCT_INTEREST_WEB_PUSH_ENABLED || "true");
  const storefrontUrl = getBaseUrl(
    overrides.storefrontUrl || process.env.STORE_FRONTEND_URL || env.frontendUrl
  );
  const brandName =
    cleanText(overrides.brandName || process.env.PRODUCT_INTEREST_BRAND_NAME, 80) ||
    "levra_perfume";
  const brandIconUrl = resolvePublicUrl(
    overrides.brandIconUrl ||
      process.env.PRODUCT_INTEREST_BRAND_ICON_URL ||
      "/assets/images/brand/store/icon-192.png",
    storefrontUrl
  );
  const brandBadgeUrl = resolvePublicUrl(
    overrides.brandBadgeUrl ||
      process.env.PRODUCT_INTEREST_BRAND_BADGE_URL ||
      "/assets/images/brand/store/icon-192.png",
    storefrontUrl
  );

  return {
    enabled:
      overrides.enabled ?? isTruthy(process.env.PRODUCT_INTEREST_NOTIFICATIONS_ENABLED),
    dryRun:
      overrides.dryRun ??
      !["0", "false", "no", "nao", "não", "off"].includes(
        String(process.env.PRODUCT_INTEREST_NOTIFICATIONS_DRY_RUN || "true")
          .trim()
          .toLowerCase()
      ),
    consentConfirmed:
      overrides.consentConfirmed ??
      isTruthy(process.env.PRODUCT_INTEREST_CONSENT_CONFIRMED),
    channel: "email",
    emailEnabled,
    webPushEnabled,
    channels: [
      ...(emailEnabled ? ["email"] : []),
      ...(webPushEnabled ? ["web_push"] : []),
    ],
    discoveryEnabled:
      overrides.discoveryEnabled ??
      isTruthy(process.env.PRODUCT_INTEREST_DISCOVERY_ENABLED || "true"),
    discoverySharePercent: clampInt(
      overrides.discoverySharePercent ??
        process.env.PRODUCT_INTEREST_DISCOVERY_SHARE_PERCENT,
      0,
      100,
      20
    ),
    discoveryCandidateLimit: clampInt(
      overrides.discoveryCandidateLimit ??
        process.env.PRODUCT_INTEREST_DISCOVERY_CANDIDATE_LIMIT,
      1,
      500,
      250
    ),
    lookbackDays: clampInt(
      overrides.lookbackDays ?? process.env.PRODUCT_INTEREST_LOOKBACK_DAYS,
      1,
      180,
      30
    ),
    halfLifeHours: clampNumber(
      overrides.halfLifeHours ?? process.env.PRODUCT_INTEREST_HALF_LIFE_HOURS,
      1,
      720,
      72
    ),
    minCategoryScore: clampNumber(
      overrides.minCategoryScore ?? process.env.PRODUCT_INTEREST_MIN_CATEGORY_SCORE,
      0,
      100,
      35
    ),
    minConfidence: clampNumber(
      overrides.minConfidence ?? process.env.PRODUCT_INTEREST_MIN_CONFIDENCE,
      0,
      100,
      30
    ),
    minMatchScore: clampNumber(
      overrides.minMatchScore ?? process.env.PRODUCT_INTEREST_MIN_MATCH_SCORE,
      0,
      100,
      55
    ),
    minQualifyingSignals: clampInt(
      overrides.minQualifyingSignals ??
        process.env.PRODUCT_INTEREST_MIN_QUALIFYING_SIGNALS,
      1,
      20,
      1
    ),
    dailyCap: clampInt(
      overrides.dailyCap ?? process.env.PRODUCT_INTEREST_DAILY_CAP,
      0,
      20,
      1
    ),
    weeklyCap: clampInt(
      overrides.weeklyCap ?? process.env.PRODUCT_INTEREST_WEEKLY_CAP,
      0,
      50,
      2
    ),
    webPushDailyCap: clampInt(
      overrides.webPushDailyCap ?? process.env.PRODUCT_INTEREST_WEB_PUSH_DAILY_CAP,
      0,
      100,
      0
    ),
    webPushWeeklyCap: clampInt(
      overrides.webPushWeeklyCap ?? process.env.PRODUCT_INTEREST_WEB_PUSH_WEEKLY_CAP,
      0,
      500,
      0
    ),
    webPushRespectDeliveryWindow:
      overrides.webPushRespectDeliveryWindow ??
      isTruthy(process.env.PRODUCT_INTEREST_WEB_PUSH_RESPECT_DELIVERY_WINDOW || "false"),
    pushAudiencePageSize: clampInt(
      overrides.pushAudiencePageSize ?? process.env.PRODUCT_INTEREST_PUSH_PAGE_SIZE,
      10,
      500,
      100
    ),
    recipientLimit: clampInt(
      overrides.recipientLimit ?? process.env.PRODUCT_INTEREST_BATCH_LIMIT,
      1,
      500,
      50
    ),
    jobLimit: clampInt(
      overrides.jobLimit ?? process.env.PRODUCT_INTEREST_JOB_LIMIT,
      1,
      20,
      2
    ),
    leaseSeconds: clampInt(
      overrides.leaseSeconds ?? process.env.PRODUCT_INTEREST_JOB_LEASE_SECONDS,
      30,
      3600,
      300
    ),
    profileRefreshLimit: clampInt(
      overrides.profileRefreshLimit ?? process.env.PRODUCT_INTEREST_PROFILE_REFRESH_LIMIT,
      1,
      100,
      25
    ),
    profileRefreshMinutes: clampInt(
      overrides.profileRefreshMinutes ??
        process.env.PRODUCT_INTEREST_PROFILE_REFRESH_MINUTES,
      1,
      1440,
      30
    ),
    timezone: cleanText(
      overrides.timezone || process.env.PRODUCT_INTEREST_TIMEZONE || "America/Bahia",
      80
    ),
    sendStartHour: clampInt(
      overrides.sendStartHour ?? process.env.PRODUCT_INTEREST_SEND_START_HOUR,
      0,
      23,
      8
    ),
    sendEndHour: clampInt(
      overrides.sendEndHour ?? process.env.PRODUCT_INTEREST_SEND_END_HOUR,
      0,
      23,
      20
    ),
    apiPublicUrl: getBaseUrl(
      overrides.apiPublicUrl ||
        process.env.PRODUCT_INTEREST_PUBLIC_API_URL ||
        env.apiBaseUrl
    ),
    storefrontUrl,
    brandName,
    brandIconUrl,
    brandBadgeUrl,
    productUrlTemplate: cleanText(
      overrides.productUrlTemplate || process.env.PRODUCT_INTEREST_PRODUCT_URL_TEMPLATE,
      1000
    ),
    unsubscribeTokenDays: clampInt(
      overrides.unsubscribeTokenDays ??
        process.env.PRODUCT_INTEREST_UNSUBSCRIBE_TOKEN_DAYS,
      1,
      730,
      365
    ),
  };
}

export function isWithinProductInterestDeliveryWindow(
  config = getProductInterestNotificationConfig(),
  now = new Date()
) {
  let hour;
  try {
    hour = Number(
      new Intl.DateTimeFormat("en-US", {
        timeZone: config.timezone,
        hour: "2-digit",
        hourCycle: "h23",
      }).format(now)
    );
  } catch {
    hour = now.getUTCHours();
  }

  const start = clampInt(config.sendStartHour, 0, 23, 8);
  const end = clampInt(config.sendEndHour, 0, 23, 20);
  if (start === end) return true;
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}

export function createProductInterestUnsubscribeToken(
  customerId,
  config = getProductInterestNotificationConfig()
) {
  return jwt.sign(
    {
      type: "product_interest_unsubscribe",
      customer_id: customerId,
      channel: "email",
    },
    env.jwtSecret,
    { expiresIn: `${config.unsubscribeTokenDays}d` }
  );
}

export function verifyProductInterestUnsubscribeToken(token) {
  const decoded = jwt.verify(String(token || ""), env.jwtSecret);
  if (
    decoded?.type !== "product_interest_unsubscribe" ||
    decoded?.channel !== "email" ||
    !decoded?.customer_id
  ) {
    const error = new Error("Token de descadastro inválido.");
    error.statusCode = 400;
    throw error;
  }
  return decoded;
}

export async function suppressCustomerProductMarketing(
  { token, reason = "customer_unsubscribe" } = {},
  { client = supabaseAdmin } = {}
) {
  const decoded = verifyProductInterestUnsubscribeToken(token);
  const { error } = await client.rpc("suppress_customer_product_marketing", {
    p_customer_id: decoded.customer_id,
    p_reason: cleanText(reason, 120) || "customer_unsubscribe",
  });
  if (error) throw error;
  return { customerId: decoded.customer_id, channel: "email", suppressed: true };
}

export function buildProductUrl(product, config) {
  const identifier = encodeURIComponent(product?.slug || product?.sku || product?.id || "");
  if (config.productUrlTemplate) {
    return config.productUrlTemplate
      .replaceAll("{productId}", encodeURIComponent(product?.id || ""))
      .replaceAll("{productSlug}", identifier)
      .replaceAll("{productSku}", encodeURIComponent(product?.sku || ""));
  }
  return `${config.storefrontUrl}/pages-html/loja/detalhe-produto.html?id=${identifier}`;
}

function buildUnsubscribeUrl(customerId, config) {
  const token = createProductInterestUnsubscribeToken(customerId, config);
  return `${config.apiPublicUrl}/api/store/customer/marketing/unsubscribe?token=${encodeURIComponent(
    token
  )}`;
}

function formatMoneyBR(value) {
  return Number(value || 0).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

export function buildProductInterestEmail({
  customer,
  product,
  productUrl,
  unsubscribeUrl,
  brandName,
  brandLogoUrl,
  storefrontUrl,
  selectionMode = "interest",
}) {
  const safeStorefrontUrl = getBaseUrl(
    storefrontUrl || process.env.STORE_FRONTEND_URL || env.frontendUrl
  );
  const safeBrandName =
    cleanText(brandName || process.env.PRODUCT_INTEREST_BRAND_NAME, 80) ||
    "levra_perfume";
  const safeBrandLogoUrl = resolvePublicUrl(
    brandLogoUrl ||
      process.env.PRODUCT_INTEREST_BRAND_ICON_URL ||
      "/assets/images/brand/store/icon-192.png",
    safeStorefrontUrl
  );
  const customerName = cleanText(customer?.full_name, 120).split(/\s+/)[0] || "Cliente";
  const productName =
    cleanText(product?.name, 180) || `Novidade da ${safeBrandName}`;
  const category = cleanText(product?.category, 120) || "uma categoria que você acompanha";
  const price = formatMoneyBR(product?.price);
  const imageUrl = resolvePublicUrl(
    product?.image_card_url || product?.image_thumb_url || product?.image_url,
    safeStorefrontUrl
  );
  const safeProductUrl =
    resolvePublicUrl(productUrl, safeStorefrontUrl) || cleanText(productUrl, 1000) || "#";
  const subject = `${productName} chegou na ${safeBrandName}`;
  const discoveryMode = selectionMode === "discovery";
  const introduction = discoveryMode
    ? `Olá, ${customerName}. Como ainda estamos conhecendo suas preferências, selecionamos uma novidade para você descobrir.`
    : `Olá, ${customerName}. Chegou uma novidade em uma categoria que você acompanha.`;
  const brandHtml = safeBrandLogoUrl
    ? `<table role="presentation" cellspacing="0" cellpadding="0" style="margin:0 0 22px;"><tr><td style="padding-right:12px;"><img src="${escapeHtml(
        safeBrandLogoUrl
      )}" alt="${escapeHtml(
        safeBrandName
      )}" width="54" height="54" style="display:block;width:54px;height:54px;border-radius:14px;object-fit:cover;" /></td><td style="font-size:16px;font-weight:700;color:#111827;">${escapeHtml(
        safeBrandName
      )}</td></tr></table>`
    : `<p style="margin:0 0 22px;font-size:16px;font-weight:700;color:#111827;">${escapeHtml(
        safeBrandName
      )}</p>`;
  const imageHtml = imageUrl
    ? `<img src="${escapeHtml(imageUrl)}" alt="${escapeHtml(productName)}" width="520" style="display:block;width:100%;max-width:520px;height:auto;margin:0 auto 22px;border-radius:14px;" />`
    : "";

  const html = `<!doctype html>
<html lang="pt-BR">
  <head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(subject)}</title></head>
  <body style="margin:0;background:#f5f5f5;font-family:Arial,Helvetica,sans-serif;color:#111827;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="padding:24px 12px;background:#f5f5f5;">
      <tr><td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:620px;background:#ffffff;border:1px solid #e5e7eb;border-radius:16px;overflow:hidden;">
          <tr><td style="padding:28px;">
            ${brandHtml}
            <h1 style="margin:0 0 18px;font-size:24px;line-height:1.3;">${escapeHtml(
              productName
            )} acabou de chegar</h1>
            <p style="margin:0 0 18px;font-size:16px;line-height:1.6;">${escapeHtml(introduction)}</p>
            ${imageHtml}
            <h2 style="margin:0 0 8px;font-size:21px;line-height:1.35;">${escapeHtml(productName)}</h2>
            <p style="margin:0 0 8px;color:#4b5563;">${escapeHtml(category)}</p>
            <p style="margin:0 0 22px;font-size:20px;font-weight:700;">${escapeHtml(price)}</p>
            <a href="${escapeHtml(safeProductUrl)}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:13px 20px;background:#111827;color:#ffffff;text-decoration:none;border-radius:10px;font-weight:700;">Ver produto</a>
            <p style="margin:28px 0 0;font-size:12px;line-height:1.6;color:#6b7280;">Você recebeu esta mensagem porque autorizou novidades da ${escapeHtml(
              safeBrandName
            )}. <a href="${escapeHtml(unsubscribeUrl)}" style="color:#374151;">Cancelar novidades por e-mail</a>.</p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;

  const text = [
    `Olá, ${customerName}.`,
    `${productName} acabou de chegar na ${safeBrandName}.`,
    discoveryMode
      ? "Uma sugestão de descoberta enquanto aprendemos suas preferências."
      : "Uma novidade em uma categoria que você acompanha.",
    `${productName} — ${category} — ${price}`,
    `Ver produto: ${safeProductUrl}`,
    `Cancelar novidades por e-mail: ${unsubscribeUrl}`,
  ].join("\n\n");

  return { subject, text, html };
}

async function updateCampaign(client, campaignId, payload) {
  const { error } = await client
    .from("product_notification_campaigns")
    .update({ ...payload, updated_at: new Date().toISOString() })
    .eq("id", campaignId);
  if (error) throw error;
}

async function completeJob(client, jobId) {
  const now = new Date().toISOString();
  const { error } = await client
    .from("product_notification_jobs")
    .update({
      status: "completed",
      completed_at: now,
      locked_at: null,
      locked_by: null,
      last_error: null,
      updated_at: now,
    })
    .eq("id", jobId);
  if (error) throw error;
}

async function renewJobLease(client, jobId, workerId) {
  if (!jobId || !workerId) return;

  const now = new Date().toISOString();
  const { error } = await client
    .from("product_notification_jobs")
    .update({ locked_at: now, updated_at: now })
    .eq("id", jobId)
    .eq("status", "processing")
    .eq("locked_by", workerId);
  if (error) throw error;
}

async function failJob(client, job, error) {
  const attempts = Number(job?.attempts || 0);
  const maxAttempts = Number(job?.max_attempts || 3);
  const canRetry = attempts < maxAttempts;
  const delaySeconds = Math.min(3600, 60 * 2 ** Math.max(0, attempts - 1));
  const message = cleanText(error?.message || String(error), 2000) || "Falha desconhecida";
  const now = new Date().toISOString();
  const { error: updateError } = await client
    .from("product_notification_jobs")
    .update({
      status: canRetry ? "retry" : "failed",
      available_at: new Date(Date.now() + delaySeconds * 1000).toISOString(),
      locked_at: null,
      locked_by: null,
      last_error: message,
      updated_at: now,
    })
    .eq("id", job.id);
  if (updateError) throw updateError;

  await updateCampaign(client, job.campaign_id, {
    status: canRetry ? "queued" : "failed",
    last_error: message,
    ...(canRetry ? {} : { completed_at: now }),
  });
}

async function reserveDelivery(client, payload, config) {
  const { data, error } = await client.rpc("reserve_product_interest_channel_delivery", {
    p_campaign_id: payload.campaign_id,
    p_customer_id: payload.customer_id,
    p_channel: payload.channel,
    p_category_key: payload.category_key,
    p_match_score: payload.match_score,
    p_metadata: payload.metadata || {},
    p_daily_cap: config.dailyCap,
    p_weekly_cap: config.weeklyCap,
    p_dry_run: config.dryRun,
  });
  if (error) throw error;
  if (typeof data === "string") return data;
  return data?.id || data?.delivery_id || null;
}

async function reserveRecipientDelivery(client, payload, config) {
  const { data, error } = await client.rpc(
    "reserve_product_interest_recipient_delivery",
    {
      p_campaign_id: payload.campaign_id,
      p_recipient_key: payload.recipient_key,
      p_customer_id: payload.customer_id || null,
      p_visitor_id: payload.visitor_id || null,
      p_push_subscription_id: payload.push_subscription_id || null,
      p_channel: payload.channel,
      p_category_key: payload.category_key,
      p_match_score: payload.match_score,
      p_metadata: payload.metadata || {},
      p_daily_cap: config.webPushDailyCap,
      p_weekly_cap: config.webPushWeeklyCap,
      p_dry_run: config.dryRun,
    }
  );
  if (error) throw error;
  if (typeof data === "string") return data;
  return data?.id || data?.delivery_id || null;
}

function createPushAudienceSummary() {
  return {
    candidates: 0,
    targeted_candidates: 0,
    discovery_candidates: 0,
    targeted_recipients: 0,
    discovery_recipients: 0,
    selected: 0,
    simulated: 0,
    sent: 0,
    failed: 0,
    skipped: 0,
    duplicates: 0,
    channels: {
      web_push: { selected: 0, simulated: 0, sent: 0, failed: 0, skipped: 0 },
    },
  };
}

function mergeCampaignSummaries(base, addition) {
  const merged = { ...base };
  for (const key of [
    "candidates",
    "targeted_candidates",
    "discovery_candidates",
    "targeted_recipients",
    "discovery_recipients",
    "selected",
    "simulated",
    "sent",
    "failed",
    "skipped",
    "duplicates",
  ]) {
    merged[key] = Number(base?.[key] || 0) + Number(addition?.[key] || 0);
  }

  merged.channels = {
    ...(base?.channels || {}),
    ...(addition?.channels || {}),
  };
  if (merged.selected > 0) delete merged.reason;
  return merged;
}

function appendRowsByKey(map, rows, keyName) {
  for (const row of rows || []) {
    const key = cleanText(row?.[keyName], 180);
    if (!key) continue;
    const current = map.get(key) || [];
    current.push(row);
    map.set(key, current);
  }
}

async function loadActivePushSubscriptionPage(client, pageSize, cursor) {
  let query = client
    .from("customer_marketing_push_subscriptions")
    .select("id,customer_id,visitor_id,last_seen_at,profile_refreshed_at")
    .eq("is_active", true)
    .order("id", { ascending: true });

  const supportsCursor = typeof query.gt === "function";
  if (cursor && supportsCursor) query = query.gt("id", cursor);
  const { data, error } = await query.limit(pageSize);
  if (error) throw error;

  return {
    rows: Array.isArray(data) ? data : [],
    supportsCursor,
  };
}

export async function processWebPushAudience(
  {
    campaign,
    product,
    categoryKey,
    productUrl,
    config,
    nowMs,
    jobId = null,
    workerId = null,
  },
  { client, pushMailer }
) {
  const summary = createPushAudienceSummary();
  const lookbackFromMs = nowMs - config.lookbackDays * DAY_MS;
  const lookbackFrom = new Date(lookbackFromMs).toISOString();
  const refreshCutoffMs =
    nowMs - Math.max(1, Number(config.profileRefreshMinutes) || 30) * 60 * 1000;
  const seenRecipients = new Set();
  let cursor = "";
  let lastLeaseRenewalMs = Date.now();

  const renewLeaseWhenDue = async () => {
    if (!jobId || !workerId || Date.now() - lastLeaseRenewalMs < 60_000) return;
    await renewJobLease(client, jobId, workerId);
    lastLeaseRenewalMs = Date.now();
  };

  while (true) {
    await renewLeaseWhenDue();
    const page = await loadActivePushSubscriptionPage(
      client,
      config.pushAudiencePageSize,
      cursor
    );
    if (!page.rows.length) break;

    const groups = new Map();
    for (const subscription of page.rows) {
      const customerId = cleanText(subscription?.customer_id, 80);
      const visitorId = cleanText(subscription?.visitor_id, 180);
      const recipientKey = buildMarketingPushRecipientKey({ customerId, visitorId });
      if (!recipientKey || seenRecipients.has(recipientKey)) continue;

      const current = groups.get(recipientKey) || {
        recipientKey,
        customerId: customerId || null,
        visitorId: customerId ? null : visitorId || null,
        representativeSubscriptionId: subscription?.id || null,
        profileRefreshedAt: subscription?.profile_refreshed_at || null,
      };
      groups.set(recipientKey, current);
    }

    const recipients = Array.from(groups.values());
    const customerIds = recipients.map((item) => item.customerId).filter(Boolean);
    const visitorIds = recipients.map((item) => item.visitorId).filter(Boolean);

    // Garante que um visitante com sinais antigos não seja tratado como descoberta
    // apenas porque o refresh periódico ainda não chegou até ele.
    for (const item of recipients) {
      await renewLeaseWhenDue();
      if (!item.visitorId) continue;
      const refreshedMs = Date.parse(String(item.profileRefreshedAt || ""));
      if (Number.isFinite(refreshedMs) && refreshedMs >= refreshCutoffMs) continue;
      await refreshVisitorInterestProfile(item.visitorId, {
        client,
        lookbackDays: config.lookbackDays,
        nowMs,
      });
    }

    const [customersResult, customerProfilesResult, visitorProfilesResult, suppressionsResult] =
      await Promise.all([
        customerIds.length
          ? client
              .from("customers")
              .select("id,account_enabled")
              .in("id", customerIds)
          : Promise.resolve({ data: [], error: null }),
        customerIds.length
          ? client
              .from("customer_interest_profiles")
              .select(
                "customer_id,category_key,category_score,confidence,qualifying_signal_count,last_signal_at,profile_version"
              )
              .in("customer_id", customerIds)
              .gte("last_signal_at", lookbackFrom)
              .limit(Math.min(5000, Math.max(100, customerIds.length * 20)))
          : Promise.resolve({ data: [], error: null }),
        visitorIds.length
          ? client
              .from("visitor_interest_profiles")
              .select(
                "visitor_id,category_key,category_score,confidence,qualifying_signal_count,last_signal_at,profile_version"
              )
              .in("visitor_id", visitorIds)
              .gte("last_signal_at", lookbackFrom)
              .limit(Math.min(5000, Math.max(100, visitorIds.length * 20)))
          : Promise.resolve({ data: [], error: null }),
        customerIds.length
          ? client
              .from("customer_marketing_suppressions")
              .select("customer_id")
              .in("customer_id", customerIds)
              .eq("channel", "web_push")
          : Promise.resolve({ data: [], error: null }),
      ]);
    if (customersResult.error) throw customersResult.error;
    if (customerProfilesResult.error) throw customerProfilesResult.error;
    if (visitorProfilesResult.error) throw visitorProfilesResult.error;
    if (suppressionsResult.error) throw suppressionsResult.error;

    const enabledCustomers = new Set(
      (customersResult.data || [])
        .filter((row) => row?.account_enabled === true)
        .map((row) => row.id)
    );
    const suppressedCustomers = new Set(
      (suppressionsResult.data || []).map((row) => row.customer_id).filter(Boolean)
    );
    const customerProfiles = new Map();
    const visitorProfiles = new Map();
    appendRowsByKey(customerProfiles, customerProfilesResult.data, "customer_id");
    appendRowsByKey(visitorProfiles, visitorProfilesResult.data, "visitor_id");

    for (const recipient of recipients) {
      await renewLeaseWhenDue();
      seenRecipients.add(recipient.recipientKey);
      if (
        recipient.customerId &&
        (!enabledCustomers.has(recipient.customerId) ||
          suppressedCustomers.has(recipient.customerId))
      ) {
        continue;
      }

      const profiles = recipient.customerId
        ? customerProfiles.get(recipient.customerId) || []
        : visitorProfiles.get(recipient.visitorId) || [];
      const learnedProfiles = profiles.filter((profile) =>
        hasLearnedInterest(profile, config, lookbackFromMs)
      );
      const matchingProfile = learnedProfiles.find(
        (profile) => profile.category_key === categoryKey
      );

      let selectionMode = "discovery";
      let evaluation = {
        eligible: true,
        matchScore: 0,
        recencyScore: 0,
        reasons: ["discovery_until_interest_learned"],
      };
      let profile = {
        category_score: 0,
        confidence: 0,
        qualifying_signal_count: 0,
        profile_version: "discovery-v2",
      };

      if (learnedProfiles.length) {
        summary.targeted_candidates += 1;
        if (!matchingProfile) continue;
        evaluation = evaluateInterestEligibility(matchingProfile, config, nowMs);
        if (!evaluation.eligible) continue;
        profile = matchingProfile;
        selectionMode = "interest";
        summary.targeted_recipients += 1;
      } else {
        summary.discovery_candidates += 1;
        if (!config.discoveryEnabled) continue;
        summary.discovery_recipients += 1;
      }

      summary.candidates += 1;
      const deliveryId = await reserveRecipientDelivery(
        client,
        {
          campaign_id: campaign.id,
          recipient_key: recipient.recipientKey,
          customer_id: recipient.customerId,
          visitor_id: recipient.visitorId,
          push_subscription_id: recipient.representativeSubscriptionId,
          channel: "web_push",
          category_key: categoryKey,
          match_score: evaluation.matchScore,
          metadata: {
            category_score: Number(profile.category_score || 0),
            confidence: Number(profile.confidence || 0),
            recency_score: evaluation.recencyScore,
            qualifying_signal_count: Number(profile.qualifying_signal_count || 0),
            profile_version: profile.profile_version,
            selection_mode: selectionMode,
            recipient_type: recipient.customerId ? "customer" : "visitor",
            dry_run: config.dryRun,
          },
        },
        config
      );

      if (!deliveryId) {
        summary.duplicates += 1;
        continue;
      }

      summary.selected += 1;
      summary.channels.web_push.selected += 1;
      if (config.dryRun) {
        summary.simulated += 1;
        summary.channels.web_push.simulated += 1;
        continue;
      }

      const sendResult = await pushMailer(
        {
          customerId: recipient.customerId,
          visitorId: recipient.visitorId,
          product,
          productUrl,
          campaignId: campaign.id,
          brandName: config.brandName,
          brandIconUrl: config.brandIconUrl,
          brandBadgeUrl: config.brandBadgeUrl,
          storefrontUrl: config.storefrontUrl,
        },
        { client }
      );
      await renewLeaseWhenDue();
      const sent = sendResult?.success === true;
      const skipped = !sent && sendResult?.skipped === true;
      const { error: deliveryUpdateError } = await client
        .from("customer_notification_deliveries")
        .update({
          status: sent ? "sent" : skipped ? "skipped" : "failed",
          provider_message_id:
            cleanText(sendResult?.messageId || sendResult?.providerMessageId, 500) || null,
          failure_reason: sent
            ? null
            : cleanText(sendResult?.reason || sendResult?.error, 1000) || "send_failed",
          sent_at: sent ? new Date().toISOString() : null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", deliveryId);
      if (deliveryUpdateError) throw deliveryUpdateError;

      if (sent) {
        summary.sent += 1;
        summary.channels.web_push.sent += 1;
      } else if (skipped) {
        summary.skipped += 1;
        summary.channels.web_push.skipped += 1;
      } else {
        summary.failed += 1;
        summary.channels.web_push.failed += 1;
      }
    }

    const lastId = cleanText(page.rows[page.rows.length - 1]?.id, 80);
    if (!page.supportsCursor || page.rows.length < config.pushAudiencePageSize || !lastId) {
      break;
    }
    cursor = lastId;
  }

  return summary;
}

async function loadCampaignContext(client, job) {
  const { data: campaign, error: campaignError } = await client
    .from("product_notification_campaigns")
    .select("id,product_id,campaign_type,status")
    .eq("id", job.campaign_id)
    .maybeSingle();
  if (campaignError) throw campaignError;
  if (!campaign?.id) return { campaign: null, product: null };

  const { data: product, error: productError } = await client
    .from("products")
    .select(
      "id,name,sku,category,price,status,stock_quantity,image_url,image_thumb_url,image_card_url"
    )
    .eq("id", campaign.product_id)
    .maybeSingle();
  if (productError) throw productError;
  return { campaign, product };
}

function buildFrequencyMap(rows = [], nowMs = Date.now()) {
  const dailyFrom = nowMs - DAY_MS;
  const weeklyFrom = nowMs - 7 * DAY_MS;
  const map = new Map();

  for (const row of rows || []) {
    const customerId = row?.customer_id;
    const channel = cleanText(row?.channel, 40);
    const createdMs = Date.parse(String(row?.created_at || ""));
    if (!customerId || !channel || !Number.isFinite(createdMs) || createdMs < weeklyFrom) {
      continue;
    }
    const key = `${customerId}:${channel}`;
    const current = map.get(key) || { daily: 0, weekly: 0 };
    current.weekly += 1;
    if (createdMs >= dailyFrom) current.daily += 1;
    map.set(key, current);
  }

  return map;
}

function hasLearnedInterest(profile, config, lookbackFromMs) {
  const lastSignalMs = Date.parse(String(profile?.last_signal_at || ""));
  return Boolean(
    Number(profile?.category_score || 0) >= config.minCategoryScore &&
      Number(profile?.confidence || 0) >= config.minConfidence &&
      Number(profile?.qualifying_signal_count || 0) >= config.minQualifyingSignals &&
      Number.isFinite(lastSignalMs) &&
      lastSignalMs >= lookbackFromMs
  );
}

async function loadDiscoveryCustomerIds(
  client,
  config,
  { targetedCustomerIds = [], lookbackFrom, lookbackFromMs }
) {
  if (!config.discoveryEnabled) return [];

  const poolLimit = Math.max(
    config.recipientLimit,
    config.discoveryCandidateLimit
  );
  const [emailCandidatesResult, pushCandidatesResult] = await Promise.all([
    config.emailEnabled
      ? client
          .from("customers")
          .select("id")
          .eq("account_enabled", true)
          .eq("newsletter_opt_in", true)
          .limit(poolLimit)
      : Promise.resolve({ data: [], error: null }),
    config.webPushEnabled
      ? client
          .from("customer_marketing_push_subscriptions")
          .select("customer_id")
          .eq("is_active", true)
          .limit(poolLimit)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (emailCandidatesResult.error) throw emailCandidatesResult.error;
  if (pushCandidatesResult.error) throw pushCandidatesResult.error;

  const targeted = new Set(targetedCustomerIds);
  const poolIds = Array.from(
    new Set([
      ...(emailCandidatesResult.data || []).map((row) => row.id),
      ...(pushCandidatesResult.data || []).map((row) => row.customer_id),
    ].filter(Boolean))
  )
    .filter((customerId) => !targeted.has(customerId))
    .slice(0, poolLimit);

  if (!poolIds.length) return [];

  const profileLimit = Math.min(5000, Math.max(poolIds.length, poolIds.length * 10));
  const { data: learnedProfiles, error: learnedProfilesError } = await client
    .from("customer_interest_profiles")
    .select("customer_id,category_score,confidence,qualifying_signal_count,last_signal_at")
    .in("customer_id", poolIds)
    .gte("last_signal_at", lookbackFrom)
    .order("last_signal_at", { ascending: false })
    .limit(profileLimit);
  if (learnedProfilesError) throw learnedProfilesError;

  const learnedCustomerIds = new Set(
    (learnedProfiles || [])
      .filter((profile) => hasLearnedInterest(profile, config, lookbackFromMs))
      .map((profile) => profile.customer_id)
      .filter(Boolean)
  );

  return poolIds.filter((customerId) => !learnedCustomerIds.has(customerId));
}

function getAvailableDeliveryChannels(
  customer,
  config,
  { suppressed, pushCustomers, frequency }
) {
  if (!customer?.id || customer.account_enabled !== true) return [];

  const channels = [];
  if (
    config.emailEnabled &&
    customer.newsletter_opt_in === true &&
    isValidEmail(customer.email) &&
    !suppressed.has(`${customer.id}:email`)
  ) {
    const counts = frequency.get(`${customer.id}:email`) || { daily: 0, weekly: 0 };
    if (
      (config.dailyCap <= 0 || counts.daily < config.dailyCap) &&
      (config.weeklyCap <= 0 || counts.weekly < config.weeklyCap)
    ) {
      channels.push("email");
    }
  }

  if (
    config.webPushEnabled &&
    pushCustomers.has(customer.id) &&
    !suppressed.has(`${customer.id}:web_push`)
  ) {
    const counts = frequency.get(`${customer.id}:web_push`) || { daily: 0, weekly: 0 };
    if (
      (config.dailyCap <= 0 || counts.daily < config.dailyCap) &&
      (config.weeklyCap <= 0 || counts.weekly < config.weeklyCap)
    ) {
      channels.push("web_push");
    }
  }

  return channels;
}

function allocateCampaignRecipients(interestCandidates, discoveryCandidates, config) {
  const limit = config.recipientLimit;
  if (!interestCandidates.length) return discoveryCandidates.slice(0, limit);
  if (!discoveryCandidates.length) return interestCandidates.slice(0, limit);
  if (limit === 1) return interestCandidates.slice(0, 1);

  const requestedDiscoverySlots =
    config.discoverySharePercent > 0
      ? Math.max(1, Math.round((limit * config.discoverySharePercent) / 100))
      : 0;
  const discoverySlots = Math.min(limit - 1, requestedDiscoverySlots);
  const recipients = [
    ...interestCandidates.slice(0, limit - discoverySlots),
    ...discoveryCandidates.slice(0, discoverySlots),
  ];
  const selectedIds = new Set(recipients.map((item) => item.customer.id));

  for (const candidate of [...interestCandidates, ...discoveryCandidates]) {
    if (recipients.length >= limit) break;
    if (selectedIds.has(candidate.customer.id)) continue;
    recipients.push(candidate);
    selectedIds.add(candidate.customer.id);
  }

  return recipients;
}

async function processCampaignJob(job, config, { client, mailer, pushMailer, nowMs }) {
  const { campaign, product } = await loadCampaignContext(client, job);
  if (!campaign) {
    await completeJob(client, job.id);
    return { jobId: job.id, skipped: true, reason: "campaign_not_found" };
  }

  const productAvailable =
    String(product?.status || "").trim().toLowerCase() === "active" &&
    Number(product?.stock_quantity || 0) > 0;
  const categoryKey = normalizeInterestCategory(product?.category);

  if (!product?.id || !productAvailable || !categoryKey) {
    const reason = !product?.id
      ? "product_not_found"
      : !productAvailable
        ? "product_unavailable"
        : "product_without_category";
    await updateCampaign(client, campaign.id, {
      status: "completed",
      category_key: categoryKey || null,
      summary: { reason, selected: 0, sent: 0, simulated: 0 },
      completed_at: new Date(nowMs).toISOString(),
    });
    await completeJob(client, job.id);
    return { jobId: job.id, skipped: true, reason };
  }

  await updateCampaign(client, campaign.id, {
    status: "processing",
    category_key: categoryKey,
    product_snapshot: {
      id: product.id,
      name: product.name,
      sku: product.sku,
      category: product.category,
      price: product.price,
      status: product.status,
      stock_quantity: product.stock_quantity,
      image_url: product.image_card_url || product.image_thumb_url || product.image_url || null,
    },
    started_at: new Date(nowMs).toISOString(),
    last_error: null,
  });

  const productUrl = buildProductUrl(product, config);
  const pushSummary = config.webPushEnabled
    ? await processWebPushAudience(
        {
          campaign,
          product,
          categoryKey,
          productUrl,
          config,
          nowMs,
          jobId: job.id,
          workerId: WORKER_ID,
        },
        { client, pushMailer }
      )
    : createPushAudienceSummary();

  if (!config.emailEnabled) {
    if (!pushSummary.selected) {
      pushSummary.reason = config.discoveryEnabled
        ? "no_eligible_audience"
        : "no_interest_profiles";
    }
    await updateCampaign(client, campaign.id, {
      status: "completed",
      summary: pushSummary,
      completed_at: new Date().toISOString(),
    });
    await completeJob(client, job.id);
    return { jobId: job.id, campaignId: campaign.id, categoryKey, ...pushSummary };
  }

  // O caminho legado abaixo continua responsável apenas pelo e-mail. Web Push
  // usa a audiência por visitante/cliente acima e nunca é cortado por batch.
  config = {
    ...config,
    webPushEnabled: false,
    channels: ["email"],
  };

  const candidateLimit = Math.min(
    1000,
    Math.max(config.recipientLimit, config.recipientLimit * 5)
  );
  const lookbackFromMs = nowMs - config.lookbackDays * DAY_MS;
  const lookbackFrom = new Date(lookbackFromMs).toISOString();
  const { data: profiles, error: profilesError } = await client
    .from("customer_interest_profiles")
    .select(
      "customer_id,category_key,category_score,confidence,qualifying_signal_count,last_signal_at,profile_version"
    )
    .eq("category_key", categoryKey)
    .gte("category_score", config.minCategoryScore)
    .gte("confidence", config.minConfidence)
    .gte("qualifying_signal_count", config.minQualifyingSignals)
    .gte("last_signal_at", lookbackFrom)
    .order("category_score", { ascending: false })
    .order("confidence", { ascending: false })
    .limit(candidateLimit);
  if (profilesError) throw profilesError;

  const customerIds = Array.from(
    new Set((profiles || []).map((row) => row.customer_id).filter(Boolean))
  );
  const discoveryCustomerIds = await loadDiscoveryCustomerIds(client, config, {
    targetedCustomerIds: customerIds,
    lookbackFrom,
    lookbackFromMs,
  });
  const audienceCustomerIds = Array.from(
    new Set([...customerIds, ...discoveryCustomerIds])
  );

  if (!audienceCustomerIds.length) {
    const reason = config.discoveryEnabled
      ? "no_eligible_audience"
      : "no_interest_profiles";
    const completedSummary = mergeCampaignSummaries(
      {
        reason,
        candidates: 0,
        targeted_candidates: 0,
        discovery_candidates: 0,
        targeted_recipients: 0,
        discovery_recipients: 0,
        selected: 0,
        sent: 0,
        simulated: 0,
        failed: 0,
        skipped: 0,
        duplicates: 0,
        channels: {
          email: { selected: 0, simulated: 0, sent: 0, failed: 0, skipped: 0 },
        },
      },
      pushSummary
    );
    await updateCampaign(client, campaign.id, {
      status: "completed",
      summary: completedSummary,
      completed_at: new Date(nowMs).toISOString(),
    });
    await completeJob(client, job.id);
    return {
      jobId: job.id,
      campaignId: campaign.id,
      categoryKey,
      ...completedSummary,
    };
  }

  const countedDeliveryStatuses = config.dryRun
    ? ["pending", "simulated", "sent"]
    : ["pending", "sent"];
  const [
    customersResult,
    suppressionsResult,
    deliveriesResult,
    pushSubscriptionsResult,
  ] = await Promise.all([
    client
      .from("customers")
      .select("id,full_name,email,newsletter_opt_in,account_enabled")
      .in("id", audienceCustomerIds)
      .eq("account_enabled", true),
    client
      .from("customer_marketing_suppressions")
      .select("customer_id,channel")
      .in("customer_id", audienceCustomerIds)
      .in("channel", config.channels),
    client
      .from("customer_notification_deliveries")
      .select("customer_id,channel,created_at,status")
      .in("customer_id", audienceCustomerIds)
      .in("channel", config.channels)
      .in("status", countedDeliveryStatuses)
      .gte("created_at", new Date(nowMs - 7 * DAY_MS).toISOString()),
    config.webPushEnabled
      ? client
          .from("customer_marketing_push_subscriptions")
          .select("customer_id")
          .in("customer_id", audienceCustomerIds)
          .eq("is_active", true)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (customersResult.error) throw customersResult.error;
  if (suppressionsResult.error) throw suppressionsResult.error;
  if (deliveriesResult.error) throw deliveriesResult.error;
  if (pushSubscriptionsResult.error) throw pushSubscriptionsResult.error;

  const customersById = new Map((customersResult.data || []).map((row) => [row.id, row]));
  const suppressed = new Set(
    (suppressionsResult.data || []).map((row) => `${row.customer_id}:${row.channel}`)
  );
  const pushCustomers = new Set(
    (pushSubscriptionsResult.data || []).map((row) => row.customer_id)
  );
  const frequency = buildFrequencyMap(deliveriesResult.data || [], nowMs);

  const interestCandidates = [];
  for (const profile of profiles || []) {
    const customer = customersById.get(profile.customer_id);
    if (!customer) continue;

    const evaluation = evaluateInterestEligibility(profile, config, nowMs);
    if (!evaluation.eligible) continue;

    const channels = getAvailableDeliveryChannels(customer, config, {
      suppressed,
      pushCustomers,
      frequency,
    });
    if (channels.length) {
      interestCandidates.push({
        profile,
        customer,
        evaluation,
        channels,
        selectionMode: "interest",
      });
    }
  }

  interestCandidates.sort(
    (a, b) =>
      b.evaluation.matchScore - a.evaluation.matchScore ||
      String(a.customer.id).localeCompare(String(b.customer.id))
  );

  const discoveryCandidates = [];
  for (const customerId of discoveryCustomerIds) {
    const customer = customersById.get(customerId);
    if (!customer) continue;
    const channels = getAvailableDeliveryChannels(customer, config, {
      suppressed,
      pushCustomers,
      frequency,
    });
    if (!channels.length) continue;

    discoveryCandidates.push({
      profile: {
        customer_id: customerId,
        category_key: categoryKey,
        category_score: 0,
        confidence: 0,
        qualifying_signal_count: 0,
        last_signal_at: null,
        profile_version: "discovery-v1",
      },
      customer,
      evaluation: {
        eligible: true,
        matchScore: 0,
        recencyScore: 0,
        reasons: ["discovery_until_interest_learned"],
      },
      channels,
      selectionMode: "discovery",
    });
  }
  discoveryCandidates.sort((a, b) =>
    String(a.customer.id).localeCompare(String(b.customer.id))
  );

  const recipients = allocateCampaignRecipients(
    interestCandidates,
    discoveryCandidates,
    config
  );

  const summary = {
    candidates: (profiles || []).length + discoveryCustomerIds.length,
    targeted_candidates: (profiles || []).length,
    discovery_candidates: discoveryCustomerIds.length,
    targeted_recipients: recipients.filter(
      (item) => item.selectionMode === "interest"
    ).length,
    discovery_recipients: recipients.filter(
      (item) => item.selectionMode === "discovery"
    ).length,
    selected: 0,
    simulated: 0,
    sent: 0,
    failed: 0,
    skipped: 0,
    duplicates: 0,
    channels: {
      email: { selected: 0, simulated: 0, sent: 0, failed: 0, skipped: 0 },
      web_push: { selected: 0, simulated: 0, sent: 0, failed: 0, skipped: 0 },
    },
  };
  if (!recipients.length) summary.reason = "no_available_channels";
  for (const item of recipients) {
    for (const channel of item.channels) {
      const deliveryId = await reserveDelivery(
        client,
        {
          campaign_id: campaign.id,
          customer_id: item.customer.id,
          channel,
          category_key: categoryKey,
          match_score: item.evaluation.matchScore,
          metadata: {
            category_score: Number(item.profile.category_score),
            confidence: Number(item.profile.confidence),
            recency_score: item.evaluation.recencyScore,
            qualifying_signal_count: Number(item.profile.qualifying_signal_count),
            profile_version: item.profile.profile_version,
            selection_mode: item.selectionMode,
            dry_run: config.dryRun,
          },
        },
        config
      );

      if (!deliveryId) {
        summary.duplicates += 1;
        continue;
      }
      summary.selected += 1;
      summary.channels[channel].selected += 1;

      if (config.dryRun) {
        summary.simulated += 1;
        summary.channels[channel].simulated += 1;
        continue;
      }

      let sendResult;
      if (channel === "email") {
        const unsubscribeUrl = buildUnsubscribeUrl(item.customer.id, config);
        const email = buildProductInterestEmail({
          customer: item.customer,
          product,
          productUrl,
          unsubscribeUrl,
          brandName: config.brandName,
          brandLogoUrl: config.brandIconUrl,
          storefrontUrl: config.storefrontUrl,
          selectionMode: item.selectionMode,
        });
        sendResult = await mailer({
          to: item.customer.email,
          ...email,
          fromName: config.brandName,
          headers: {
            "List-Unsubscribe": `<${unsubscribeUrl}>`,
            "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
            "List-ID": "Novidades levra_perfume <novidades.levra-perfume>",
            "X-Levra-Campaign-ID": campaign.id,
          },
          logLabel: "PRODUCT INTEREST EMAIL",
          redactRecipient: true,
        });
      } else {
        sendResult = await pushMailer(
          {
            customerId: item.customer.id,
            product,
            productUrl,
            campaignId: campaign.id,
            brandName: config.brandName,
            brandIconUrl: config.brandIconUrl,
            brandBadgeUrl: config.brandBadgeUrl,
            storefrontUrl: config.storefrontUrl,
          },
          { client }
        );
      }

      const sent = sendResult?.success === true;
      const skipped = !sent && sendResult?.skipped === true;
      const { error } = await client
        .from("customer_notification_deliveries")
        .update({
          status: sent ? "sent" : skipped ? "skipped" : "failed",
          provider_message_id:
            cleanText(sendResult?.messageId || sendResult?.providerMessageId, 500) || null,
          failure_reason: sent
            ? null
            : cleanText(sendResult?.reason || sendResult?.error, 1000) || "send_failed",
          sent_at: sent ? new Date().toISOString() : null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", deliveryId);
      if (error) throw error;

      if (sent) {
        summary.sent += 1;
        summary.channels[channel].sent += 1;
      } else if (skipped) {
        summary.skipped += 1;
        summary.channels[channel].skipped += 1;
      } else {
        summary.failed += 1;
        summary.channels[channel].failed += 1;
      }
    }
  }

  const completedSummary = mergeCampaignSummaries(summary, pushSummary);
  await updateCampaign(client, campaign.id, {
    status: "completed",
    summary: completedSummary,
    completed_at: new Date().toISOString(),
  });
  await completeJob(client, job.id);
  return {
    jobId: job.id,
    campaignId: campaign.id,
    categoryKey,
    ...completedSummary,
  };
}

export async function runProductInterestNotificationSweep(
  { trigger = "interval", config: configOverrides = {} } = {},
  {
    client = supabaseAdmin,
    mailer = sendSmtpEmail,
    pushMailer = sendCustomerMarketingPush,
    nowMs = Date.now(),
  } = {}
) {
  const config = getProductInterestNotificationConfig(configOverrides);
  if (!config.enabled) return { skipped: true, reason: "feature_disabled", trigger };
  if (!config.channels.length) {
    return { skipped: true, reason: "no_delivery_channels_enabled", trigger };
  }

  const refreshOptions = {
    limit: config.profileRefreshLimit,
    minRefreshMinutes: config.profileRefreshMinutes,
    lookbackDays: config.lookbackDays,
    nowMs,
  };
  const [customerProfileRefresh, visitorProfileRefresh] = await Promise.all([
    refreshCustomerInterestProfilesBatch(refreshOptions, { client }),
    config.webPushEnabled
      ? refreshVisitorInterestProfilesBatch(refreshOptions, { client })
      : Promise.resolve({ checked: 0, refreshed: 0, failed: 0, failures: [] }),
  ]);
  const profileRefresh = {
    customers: customerProfileRefresh,
    visitors: visitorProfileRefresh,
  };

  if (!config.dryRun && !config.consentConfirmed) {
    return {
      skipped: true,
      reason: "consent_text_not_confirmed",
      trigger,
      profileRefresh,
    };
  }
  if (!config.dryRun && !isWithinProductInterestDeliveryWindow(config, new Date(nowMs))) {
    const canSendPushOutsideWindow =
      config.webPushEnabled &&
      !config.webPushRespectDeliveryWindow &&
      !config.emailEnabled;
    if (!canSendPushOutsideWindow) {
      return { skipped: true, reason: "outside_delivery_window", trigger, profileRefresh };
    }
  }
  if (!config.dryRun && (!config.apiPublicUrl || !config.storefrontUrl)) {
    return { skipped: true, reason: "public_urls_not_configured", trigger, profileRefresh };
  }

  const { data: jobs, error: claimError } = await client.rpc(
    "claim_product_notification_jobs",
    {
      p_worker_id: WORKER_ID,
      p_limit: config.jobLimit,
      p_lease_seconds: config.leaseSeconds,
    }
  );
  if (claimError) throw claimError;

  const result = {
    trigger,
    dryRun: config.dryRun,
    profileRefresh,
    claimed: Array.isArray(jobs) ? jobs.length : 0,
    completed: 0,
    failed: 0,
    jobs: [],
  };

  for (const job of jobs || []) {
    try {
      const jobResult = await processCampaignJob(job, config, {
        client,
        mailer,
        pushMailer,
        nowMs,
      });
      result.completed += 1;
      result.jobs.push(jobResult);
    } catch (error) {
      result.failed += 1;
      result.jobs.push({
        jobId: job.id,
        failed: true,
        code: error?.code || null,
        message: cleanText(error?.message || String(error), 500),
      });
      await failJob(client, job, error);
    }
  }

  return result;
}
