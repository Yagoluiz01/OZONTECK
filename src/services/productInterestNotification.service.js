import jwt from "jsonwebtoken";

import { env } from "../config/env.js";
import { supabaseAdmin } from "../config/supabase.js";
import { normalizeInterestCategory } from "../intelligence/interestTaxonomy.js";
import {
  evaluateInterestEligibility,
  refreshCustomerInterestProfilesBatch,
} from "./customerInterestProfile.service.js";
import { sendCustomerMarketingPush } from "./customerMarketingPush.service.js";
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

export function getProductInterestNotificationConfig(overrides = {}) {
  const emailEnabled =
    overrides.emailEnabled ??
    isTruthy(process.env.PRODUCT_INTEREST_EMAIL_ENABLED || "true");
  const webPushEnabled =
    overrides.webPushEnabled ??
    isTruthy(process.env.PRODUCT_INTEREST_WEB_PUSH_ENABLED || "true");

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
    storefrontUrl: getBaseUrl(
      overrides.storefrontUrl || process.env.STORE_FRONTEND_URL || env.frontendUrl
    ),
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

function buildProductUrl(product, config) {
  const identifier = encodeURIComponent(product?.slug || product?.sku || product?.id || "");
  if (config.productUrlTemplate) {
    return config.productUrlTemplate
      .replaceAll("{productId}", encodeURIComponent(product?.id || ""))
      .replaceAll("{productSlug}", identifier)
      .replaceAll("{productSku}", encodeURIComponent(product?.sku || ""));
  }
  return `${config.storefrontUrl}/detalhe-produto.html?id=${identifier}`;
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

export function buildProductInterestEmail({ customer, product, productUrl, unsubscribeUrl }) {
  const customerName = cleanText(customer?.full_name, 120).split(/\s+/)[0] || "Cliente";
  const productName = cleanText(product?.name, 180) || "Nova opção na OZONTECK";
  const category = cleanText(product?.category, 120) || "uma categoria que você acompanha";
  const price = formatMoneyBR(product?.price);
  const imageUrl = cleanText(
    product?.image_card_url || product?.image_thumb_url || product?.image_url,
    1000
  );
  const subject = `Novidade na OZONTECK: ${productName}`;
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
            <p style="margin:0 0 8px;font-size:14px;color:#6b7280;">OZONTECK</p>
            <h1 style="margin:0 0 18px;font-size:24px;line-height:1.3;">Uma novidade para você</h1>
            <p style="margin:0 0 18px;font-size:16px;line-height:1.6;">Olá, ${escapeHtml(customerName)}. Chegou uma novidade em uma categoria que você acompanha.</p>
            ${imageHtml}
            <h2 style="margin:0 0 8px;font-size:21px;line-height:1.35;">${escapeHtml(productName)}</h2>
            <p style="margin:0 0 8px;color:#4b5563;">${escapeHtml(category)}</p>
            <p style="margin:0 0 22px;font-size:20px;font-weight:700;">${escapeHtml(price)}</p>
            <a href="${escapeHtml(productUrl)}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:13px 20px;background:#111827;color:#ffffff;text-decoration:none;border-radius:10px;font-weight:700;">Ver produto</a>
            <p style="margin:28px 0 0;font-size:12px;line-height:1.6;color:#6b7280;">Você recebeu esta mensagem porque autorizou novidades da OZONTECK. <a href="${escapeHtml(unsubscribeUrl)}" style="color:#374151;">Cancelar novidades por e-mail</a>.</p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;

  const text = [
    `Olá, ${customerName}.`,
    "Chegou uma novidade em uma categoria que você acompanha.",
    `${productName} — ${category} — ${price}`,
    `Ver produto: ${productUrl}`,
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

  const candidateLimit = Math.min(1000, Math.max(config.recipientLimit, config.recipientLimit * 5));
  const lookbackFrom = new Date(nowMs - config.lookbackDays * DAY_MS).toISOString();
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
  if (!customerIds.length) {
    await updateCampaign(client, campaign.id, {
      status: "completed",
      summary: { reason: "no_interest_profiles", selected: 0, sent: 0, simulated: 0 },
      completed_at: new Date(nowMs).toISOString(),
    });
    await completeJob(client, job.id);
    return { jobId: job.id, selected: 0, sent: 0, simulated: 0 };
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
      .in("id", customerIds)
      .eq("account_enabled", true),
    client
      .from("customer_marketing_suppressions")
      .select("customer_id,channel")
      .in("customer_id", customerIds)
      .in("channel", config.channels),
    client
      .from("customer_notification_deliveries")
      .select("customer_id,channel,created_at,status")
      .in("customer_id", customerIds)
      .in("channel", config.channels)
      .in("status", countedDeliveryStatuses)
      .gte("created_at", new Date(nowMs - 7 * DAY_MS).toISOString()),
    config.webPushEnabled
      ? client
          .from("customer_marketing_push_subscriptions")
          .select("customer_id")
          .in("customer_id", customerIds)
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

  const selected = [];
  for (const profile of profiles || []) {
    const customer = customersById.get(profile.customer_id);
    if (!customer) continue;

    const evaluation = evaluateInterestEligibility(profile, config, nowMs);
    if (!evaluation.eligible) continue;

    const channels = [];
    if (
      config.emailEnabled &&
      customer.newsletter_opt_in === true &&
      isValidEmail(customer.email) &&
      !suppressed.has(`${profile.customer_id}:email`)
    ) {
      const counts = frequency.get(`${profile.customer_id}:email`) || {
        daily: 0,
        weekly: 0,
      };
      if (
        (config.dailyCap <= 0 || counts.daily < config.dailyCap) &&
        (config.weeklyCap <= 0 || counts.weekly < config.weeklyCap)
      ) {
        channels.push("email");
      }
    }

    if (
      config.webPushEnabled &&
      pushCustomers.has(profile.customer_id) &&
      !suppressed.has(`${profile.customer_id}:web_push`)
    ) {
      const counts = frequency.get(`${profile.customer_id}:web_push`) || {
        daily: 0,
        weekly: 0,
      };
      if (
        (config.dailyCap <= 0 || counts.daily < config.dailyCap) &&
        (config.weeklyCap <= 0 || counts.weekly < config.weeklyCap)
      ) {
        channels.push("web_push");
      }
    }

    if (channels.length) selected.push({ profile, customer, evaluation, channels });
  }

  selected.sort(
    (a, b) =>
      b.evaluation.matchScore - a.evaluation.matchScore ||
      String(a.customer.id).localeCompare(String(b.customer.id))
  );

  const summary = {
    candidates: (profiles || []).length,
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
  const productUrl = buildProductUrl(product, config);

  for (const item of selected.slice(0, config.recipientLimit)) {
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
        });
        sendResult = await mailer({
          to: item.customer.email,
          ...email,
          headers: {
            "List-Unsubscribe": `<${unsubscribeUrl}>`,
            "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
            "List-ID": "Novidades OZONTECK <novidades.ozonteck>",
            "X-OZ-Campaign-ID": campaign.id,
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

  await updateCampaign(client, campaign.id, {
    status: "completed",
    summary,
    completed_at: new Date().toISOString(),
  });
  await completeJob(client, job.id);
  return { jobId: job.id, campaignId: campaign.id, categoryKey, ...summary };
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

  const profileRefresh = await refreshCustomerInterestProfilesBatch(
    {
      limit: config.profileRefreshLimit,
      minRefreshMinutes: config.profileRefreshMinutes,
      lookbackDays: config.lookbackDays,
      nowMs,
    },
    { client }
  );

  if (!config.dryRun && !config.consentConfirmed) {
    return {
      skipped: true,
      reason: "consent_text_not_confirmed",
      trigger,
      profileRefresh,
    };
  }
  if (!config.dryRun && !isWithinProductInterestDeliveryWindow(config, new Date(nowMs))) {
    return { skipped: true, reason: "outside_delivery_window", trigger, profileRefresh };
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
