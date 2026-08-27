import { env } from "../config/env.js";
import { supabaseAdmin } from "../config/supabase.js";
import {
  buildMarketingCampaignPushPayload,
  sendMarketingPushSubscription,
} from "./customerMarketingPush.service.js";
import { buildMarketingAudience } from "./marketingAudience.service.js";
import {
  createMarketingClickTokenForRecipient,
} from "./marketingCampaign.service.js";
import {
  buildProductUrl,
  getProductInterestNotificationConfig,
} from "./productInterestNotification.service.js";

const WORKER_ID = `marketing-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;

function cleanText(value, maxLength = 500) {
  const text = String(value || "").trim();
  return text ? text.slice(0, maxLength) : "";
}

function isTruthy(value) {
  return ["1", "true", "yes", "sim", "on"].includes(
    String(value || "").trim().toLowerCase()
  );
}

function clampInt(value, min, max, fallback) {
  const number = Math.trunc(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

export function normalizeMarketingWorkerPublicOrigin(value, label = "URL pública") {
  try {
    const parsed = new URL(cleanText(value, 1000));
    const localDevelopment =
      env.nodeEnv !== "production" &&
      ["localhost", "127.0.0.1"].includes(parsed.hostname);
    if (
      (parsed.protocol !== "https:" && !(localDevelopment && parsed.protocol === "http:")) ||
      parsed.username ||
      parsed.password
    ) {
      throw new Error("unsafe_origin");
    }
    return parsed.origin;
  } catch {
    const error = new Error(`${label} não está configurada com uma origem segura.`);
    error.code = "marketing_worker_public_origin_invalid";
    throw error;
  }
}

export function getMarketingCampaignWorkerConfig(overrides = {}) {
  return {
    enabled:
      overrides.enabled ?? isTruthy(process.env.MARKETING_CAMPAIGN_WORKER_ENABLED),
    automationRealSendEnabled:
      overrides.automationRealSendEnabled ??
      isTruthy(process.env.MARKETING_AUTOMATION_REAL_SEND_ENABLED),
    jobLimit: clampInt(
      overrides.jobLimit ?? process.env.MARKETING_CAMPAIGN_JOB_LIMIT,
      1,
      20,
      2
    ),
    leaseSeconds: clampInt(
      overrides.leaseSeconds ?? process.env.MARKETING_CAMPAIGN_JOB_LEASE_SECONDS,
      30,
      3600,
      600
    ),
    recipientConcurrency: clampInt(
      overrides.recipientConcurrency ?? process.env.MARKETING_CAMPAIGN_RECIPIENT_CONCURRENCY,
      1,
      20,
      4
    ),
    cancellationBatchSize: clampInt(
      overrides.cancellationBatchSize ??
        process.env.MARKETING_CAMPAIGN_CANCELLATION_BATCH_SIZE,
      1,
      250,
      25
    ),
    clickTokenDays: clampInt(
      overrides.clickTokenDays ?? process.env.MARKETING_CLICK_TOKEN_DAYS,
      1,
      365,
      90
    ),
    apiPublicUrl: cleanText(
      overrides.apiPublicUrl ||
        process.env.MARKETING_PUBLIC_API_URL ||
        process.env.PRODUCT_INTEREST_PUBLIC_API_URL ||
        env.apiBaseUrl,
      1000
    ).replace(/\/+$/, ""),
    storefrontUrl: cleanText(
      overrides.storefrontUrl || process.env.STORE_FRONTEND_URL || env.frontendUrl,
      1000
    ).replace(/\/+$/, ""),
  };
}

async function loadWorkerCampaign(campaignId, client) {
  const [campaignResult, itemsResult] = await Promise.all([
    client.from("marketing_campaigns").select("*").eq("id", campaignId).maybeSingle(),
    client
      .from("marketing_campaign_items")
      .select("id,product_id,position,product_snapshot")
      .eq("campaign_id", campaignId)
      .order("position", { ascending: true }),
  ]);
  if (campaignResult.error) throw campaignResult.error;
  if (itemsResult.error) throw itemsResult.error;
  if (!campaignResult.data) {
    const error = new Error("Campanha do job não encontrada.");
    error.code = "marketing_campaign_not_found";
    throw error;
  }
  return { ...campaignResult.data, items: itemsResult.data || [] };
}

function resolveCampaignDestination(campaign, config) {
  if (campaign.destination_url) return campaign.destination_url;
  const firstProduct = campaign.items?.[0]?.product_snapshot || null;
  if (firstProduct) {
    return buildProductUrl(firstProduct, {
      ...getProductInterestNotificationConfig(),
      storefrontUrl: config.storefrontUrl,
    });
  }
  return `${config.storefrontUrl}/pages-html/loja/catalogo.html`;
}

async function ensureClickLink({ campaign, recipient, destinationUrl, config }, client) {
  const { token, tokenHash } = createMarketingClickTokenForRecipient(
    campaign.id,
    recipient.id
  );
  const expiresAt = new Date(
    Date.now() + config.clickTokenDays * 24 * 60 * 60 * 1000
  ).toISOString();
  const { error } = await client.from("marketing_click_links").upsert(
    {
      campaign_id: campaign.id,
      recipient_id: recipient.id,
      token_hash: tokenHash,
      destination_url: destinationUrl,
      expires_at: expiresAt,
    },
    { onConflict: "recipient_id" }
  );
  if (error) throw error;

  return `${config.apiPublicUrl}/api/store/marketing/click/${encodeURIComponent(token)}`;
}

async function getOrCreateRecipient(candidate, campaign, client) {
  const { data: reservedId, error: reserveError } = await client.rpc(
    "reserve_marketing_campaign_recipient",
    {
      p_campaign_id: campaign.id,
      p_recipient_key: candidate.recipientKey,
      p_customer_id: candidate.customerId,
      p_visitor_id: candidate.visitorId,
      p_selection_mode: candidate.selectionMode,
      p_category_key: candidate.categoryKey,
      p_match_score: candidate.matchScore,
      p_metadata: { device_count: candidate.subscriptions.length },
      p_daily_cap: campaign.daily_cap,
      p_weekly_cap: campaign.weekly_cap,
      p_dry_run: campaign.dry_run,
    }
  );
  if (reserveError) throw reserveError;

  if (reservedId) {
    return {
      id: reservedId,
      status: campaign.dry_run ? "simulated" : "selected",
      existing: false,
    };
  }

  const { data: existing, error: lookupError } = await client
    .from("marketing_campaign_recipients")
    .select("id,status")
    .eq("campaign_id", campaign.id)
    .eq("recipient_key", candidate.recipientKey)
    .maybeSingle();
  if (lookupError) throw lookupError;
  return existing ? { ...existing, existing: true } : null;
}

async function getOrCreateAttempt(campaignId, recipientId, subscriptionId, client) {
  const { data: existing, error: lookupError } = await client
    .from("marketing_delivery_attempts")
    .select("id,status,attempt_count")
    .eq("recipient_id", recipientId)
    .eq("push_subscription_id", subscriptionId)
    .eq("channel", "web_push")
    .maybeSingle();
  if (lookupError) throw lookupError;
  if (existing) return existing;

  const { data, error } = await client
    .from("marketing_delivery_attempts")
    .insert({
      campaign_id: campaignId,
      recipient_id: recipientId,
      push_subscription_id: subscriptionId,
      channel: "web_push",
      status: "pending",
    })
    .select("id,status,attempt_count")
    .single();
  if (error) throw error;
  return data;
}

async function markAttempt(attempt, values, client) {
  const { error } = await client
    .from("marketing_delivery_attempts")
    .update({
      ...values,
      attempt_count: Math.min(20, Number(attempt.attempt_count || 0) + 1),
      updated_at: new Date().toISOString(),
    })
    .eq("id", attempt.id);
  if (error) throw error;
}

async function recordProviderAccepted(campaignId, recipientId, attemptId, client) {
  const { error } = await client.from("marketing_campaign_events").upsert(
    {
      campaign_id: campaignId,
      recipient_id: recipientId,
      delivery_attempt_id: attemptId,
      event_type: "provider_accepted",
      event_key: `provider:${attemptId}`,
      occurred_at: new Date().toISOString(),
    },
    { onConflict: "event_key" }
  );
  if (error) throw error;
}

async function processRecipient(candidate, campaign, config, client) {
  const recipient = await getOrCreateRecipient(candidate, campaign, client);
  if (!recipient) {
    return { capped: 1, sent: 0, failed: 0, simulated: 0, skipped: 0 };
  }
  if (
    recipient.existing &&
    ["provider_accepted", "simulated"].includes(recipient.status)
  ) {
    return { capped: 0, sent: 0, failed: 0, simulated: 0, skipped: 1 };
  }

  const destinationUrl = resolveCampaignDestination(campaign, config);
  const clickUrl = campaign.dry_run
    ? destinationUrl
    : await ensureClickLink({ campaign, recipient, destinationUrl, config }, client);
  const firstProduct = campaign.items?.[0]?.product_snapshot || {};
  const payload = buildMarketingCampaignPushPayload({
    title: campaign.title,
    body: campaign.body,
    url: clickUrl,
    imageUrl:
      campaign.image_url ||
      firstProduct.image_card_url ||
      firstProduct.image_url ||
      firstProduct.image_thumb_url,
    campaignId: campaign.id,
    campaignType: campaign.campaign_type,
    storefrontUrl: config.storefrontUrl,
  });

  let sent = 0;
  let failed = 0;
  let simulated = 0;
  let skipped = 0;
  let previouslyAccepted = 0;

  for (const subscription of candidate.subscriptions) {
    const attempt = await getOrCreateAttempt(
      campaign.id,
      recipient.id,
      subscription.id,
      client
    );
    if (["provider_accepted", "simulated"].includes(attempt.status)) {
      if (attempt.status === "provider_accepted") previouslyAccepted += 1;
      skipped += 1;
      continue;
    }

    if (campaign.dry_run) {
      await markAttempt(
        attempt,
        {
          status: "simulated",
          simulated_at: new Date().toISOString(),
          attempted_at: new Date().toISOString(),
          failure_reason: null,
        },
        client
      );
      simulated += 1;
      continue;
    }

    const result = await sendMarketingPushSubscription(
      { subscription, payload },
      { client }
    );
    const now = new Date().toISOString();
    if (result.success) {
      await markAttempt(
        attempt,
        {
          status: "provider_accepted",
          provider_status_code: result.providerStatusCode,
          provider_message_id: result.providerMessageId,
          failure_reason: null,
          attempted_at: now,
          accepted_at: now,
        },
        client
      );
      await recordProviderAccepted(campaign.id, recipient.id, attempt.id, client);
      sent += 1;
    } else {
      await markAttempt(
        attempt,
        {
          status: result.stale ? "stale" : result.skipped ? "skipped" : "failed",
          provider_status_code: result.providerStatusCode,
          failure_reason: cleanText(result.error || result.reason, 500),
          attempted_at: now,
        },
        client
      );
      if (result.skipped) skipped += 1;
      else failed += 1;
    }
  }

  const acceptedDevices = sent + previouslyAccepted;
  const status = campaign.dry_run
    ? "simulated"
    : acceptedDevices > 0 && failed === 0
      ? "provider_accepted"
      : acceptedDevices > 0
        ? "partially_failed"
        : failed > 0
          ? "failed"
          : "skipped";
  const { error: recipientError } = await client
    .from("marketing_campaign_recipients")
    .update({
      status,
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", recipient.id);
  if (recipientError) throw recipientError;

  return { capped: 0, sent, failed, simulated, skipped };
}

async function mapWithConcurrency(values, concurrency, mapper) {
  const results = new Array(values.length);
  let cursor = 0;

  async function run() {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(values[index], index);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, () => run())
  );
  return results;
}

async function completeJob(job, summary, client, { dryRun = false } = {}) {
  const now = new Date().toISOString();
  const [jobResult, campaignResult] = await Promise.all([
    client
      .from("marketing_campaign_jobs")
      .update({
        status: "completed",
        completed_at: now,
        locked_at: null,
        locked_by: null,
        last_error: null,
        updated_at: now,
      })
      .eq("id", job.id),
    client
      .from("marketing_campaigns")
      .update({
        status: dryRun ? "draft" : "completed",
        summary,
        ...(dryRun
          ? { last_simulated_at: now, started_at: null, completed_at: null }
          : { completed_at: now }),
        last_error: null,
        updated_at: now,
      })
      .eq("id", job.campaign_id)
      .eq("status", "processing"),
  ]);
  if (jobResult.error) throw jobResult.error;
  if (campaignResult.error) throw campaignResult.error;
}

async function failJob(job, error, client) {
  const exhausted = Number(job.attempts || 0) >= Number(job.max_attempts || 5);
  const now = new Date();
  const delaySeconds = Math.min(3600, 30 * 2 ** Math.max(0, Number(job.attempts || 1) - 1));
  const message = cleanText(error?.message || "Falha no processamento da campanha.", 1000);
  const [jobResult, campaignResult] = await Promise.all([
    client
      .from("marketing_campaign_jobs")
      .update({
        status: exhausted ? "failed" : "retry",
        available_at: new Date(now.getTime() + delaySeconds * 1000).toISOString(),
        locked_at: null,
        locked_by: null,
        last_error: message,
        completed_at: exhausted ? now.toISOString() : null,
        updated_at: now.toISOString(),
      })
      .eq("id", job.id),
    client
      .from("marketing_campaigns")
      .update({
        status: exhausted ? "failed" : "queued",
        last_error: message,
        updated_at: now.toISOString(),
      })
      .eq("id", job.campaign_id)
      .eq("status", "processing"),
  ]);
  if (jobResult.error) throw jobResult.error;
  if (campaignResult.error) throw campaignResult.error;
}

async function heartbeatAndGetCampaignStatus(job, client) {
  const now = new Date().toISOString();
  const [heartbeatResult, campaignResult] = await Promise.all([
    client
      .from("marketing_campaign_jobs")
      .update({ locked_at: now, updated_at: now })
      .eq("id", job.id)
      .eq("status", "processing")
      .eq("locked_by", WORKER_ID),
    client
      .from("marketing_campaigns")
      .select("status")
      .eq("id", job.campaign_id)
      .maybeSingle(),
  ]);
  if (heartbeatResult.error) throw heartbeatResult.error;
  if (campaignResult.error) throw campaignResult.error;
  return cleanText(campaignResult.data?.status, 40).toLowerCase();
}

async function interruptJob(job, status, summary, client) {
  const now = new Date().toISOString();
  const [jobResult, campaignResult] = await Promise.all([
    client
      .from("marketing_campaign_jobs")
      .update({
        status: "cancelled",
        completed_at: now,
        locked_at: null,
        locked_by: null,
        last_error: null,
        updated_at: now,
      })
      .eq("id", job.id),
    client
      .from("marketing_campaigns")
      .update({ summary, updated_at: now })
      .eq("id", job.campaign_id)
      .eq("status", status),
  ]);
  if (jobResult.error) throw jobResult.error;
  if (campaignResult.error) throw campaignResult.error;
}

export async function processMarketingCampaignJobs(
  { trigger = "worker", config: configOverrides = {} } = {},
  { client = supabaseAdmin } = {}
) {
  const config = getMarketingCampaignWorkerConfig(configOverrides);
  if (!config.enabled) {
    return { enabled: false, trigger, claimed: 0, completed: 0, failed: 0, jobs: [] };
  }

  const { data: jobs, error: claimError } = await client.rpc(
    "claim_marketing_campaign_jobs",
    {
      p_worker_id: WORKER_ID,
      p_limit: config.jobLimit,
      p_lease_seconds: config.leaseSeconds,
    }
  );
  if (claimError) throw claimError;

  const results = [];
  let completed = 0;
  let failed = 0;

  for (const job of jobs || []) {
    try {
      const campaign = await loadWorkerCampaign(job.campaign_id, client);
      if (["paused", "cancelled", "completed"].includes(campaign.status)) {
        const { error } = await client
          .from("marketing_campaign_jobs")
          .update({
            status: campaign.status === "completed" ? "completed" : "cancelled",
            completed_at: new Date().toISOString(),
            locked_at: null,
            locked_by: null,
            updated_at: new Date().toISOString(),
          })
          .eq("id", job.id);
        if (error) throw error;
        results.push({ jobId: job.id, campaignId: campaign.id, skipped: campaign.status });
        completed += 1;
        continue;
      }
      if (
        campaign.source !== "manual" &&
        campaign.dry_run === false &&
        !config.automationRealSendEnabled
      ) {
        const safetyError = new Error(
          "Envio automático real bloqueado pela configuração de segurança."
        );
        safetyError.code = "marketing_automation_real_send_locked";
        throw safetyError;
      }

      const runtimeConfig = {
        ...config,
        storefrontUrl: normalizeMarketingWorkerPublicOrigin(
          config.storefrontUrl,
          "A URL pública da loja"
        ),
        ...(campaign.dry_run
          ? {}
          : {
              apiPublicUrl: normalizeMarketingWorkerPublicOrigin(
                config.apiPublicUrl,
                "A URL pública da API"
              ),
            }),
      };

      const { error: startError } = await client
        .from("marketing_campaigns")
        .update({
          status: "processing",
          started_at: campaign.started_at || new Date().toISOString(),
          last_error: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", campaign.id)
        .in("status", ["queued", "scheduled", "processing"]);
      if (startError) throw startError;

      const audience = await buildMarketingAudience(
        {
          campaign,
          items: campaign.items,
          includeRecipients: !campaign.dry_run,
        },
        { client }
      );

      if (campaign.dry_run) {
        const currentStatus = await heartbeatAndGetCampaignStatus(job, client);
        const interruptedStatus = ["paused", "cancelled"].includes(currentStatus)
          ? currentStatus
          : null;
        const summary = {
          active_subscriptions: audience.activeSubscriptions,
          unique_recipients: audience.uniqueRecipients,
          selected_recipients: audience.selectedRecipients,
          selected_devices: audience.selectedDevices,
          interest_recipients: audience.interestRecipients,
          discovery_recipients: audience.discoveryRecipients,
          all_opted_in_recipients: audience.allOptedInRecipients,
          category_recipients: audience.categoryRecipients,
          suppressed_recipients: audience.suppressedRecipients,
          excluded_by_interest: audience.excludedByInterest,
          capped_recipients: 0,
          provider_accepted_attempts: 0,
          failed_attempts: 0,
          simulated_attempts: audience.selectedDevices,
          skipped_attempts: 0,
          dry_run: true,
          interrupted: Boolean(interruptedStatus),
          interrupted_status: interruptedStatus,
          completed_at: new Date().toISOString(),
        };
        if (interruptedStatus) {
          await interruptJob(job, interruptedStatus, summary, client);
          results.push({ jobId: job.id, campaignId: campaign.id, ...summary });
          completed += 1;
          continue;
        }
        await completeJob(job, summary, client, { dryRun: true });
        results.push({ jobId: job.id, campaignId: campaign.id, ...summary });
        completed += 1;
        continue;
      }

      const recipientResults = [];
      let interruptedStatus = null;
      for (
        let offset = 0;
        offset < audience.recipients.length;
        offset += config.cancellationBatchSize
      ) {
        const currentStatus = await heartbeatAndGetCampaignStatus(job, client);
        if (["paused", "cancelled"].includes(currentStatus)) {
          interruptedStatus = currentStatus;
          break;
        }
        const batch = audience.recipients.slice(
          offset,
          offset + config.cancellationBatchSize
        );
        recipientResults.push(
          ...(await mapWithConcurrency(
            batch,
            config.recipientConcurrency,
            (candidate) => processRecipient(candidate, campaign, runtimeConfig, client)
          ))
        );
      }
      if (!interruptedStatus) {
        const currentStatus = await heartbeatAndGetCampaignStatus(job, client);
        if (["paused", "cancelled"].includes(currentStatus)) {
          interruptedStatus = currentStatus;
        }
      }
      const totals = recipientResults.reduce(
        (accumulator, item) => {
          for (const key of Object.keys(accumulator)) {
            accumulator[key] += Number(item?.[key] || 0);
          }
          return accumulator;
        },
        { capped: 0, sent: 0, failed: 0, simulated: 0, skipped: 0 }
      );
      const summary = {
        active_subscriptions: audience.activeSubscriptions,
        unique_recipients: audience.uniqueRecipients,
        selected_recipients: audience.selectedRecipients,
        selected_devices: audience.selectedDevices,
        interest_recipients: audience.interestRecipients,
        discovery_recipients: audience.discoveryRecipients,
        all_opted_in_recipients: audience.allOptedInRecipients,
        category_recipients: audience.categoryRecipients,
        suppressed_recipients: audience.suppressedRecipients,
        excluded_by_interest: audience.excludedByInterest,
        capped_recipients: totals.capped,
        provider_accepted_attempts: totals.sent,
        failed_attempts: totals.failed,
        simulated_attempts: totals.simulated,
        skipped_attempts: totals.skipped,
        dry_run: campaign.dry_run,
        interrupted: Boolean(interruptedStatus),
        interrupted_status: interruptedStatus,
        completed_at: new Date().toISOString(),
      };
      if (interruptedStatus) {
        await interruptJob(job, interruptedStatus, summary, client);
        results.push({
          jobId: job.id,
          campaignId: campaign.id,
          ...summary,
        });
        completed += 1;
        continue;
      }
      await completeJob(job, summary, client, { dryRun: false });
      results.push({ jobId: job.id, campaignId: campaign.id, ...summary });
      completed += 1;
    } catch (error) {
      await failJob(job, error, client);
      results.push({
        jobId: job.id,
        campaignId: job.campaign_id,
        error: cleanText(error?.message, 500),
      });
      failed += 1;
    }
  }

  return {
    enabled: true,
    trigger,
    claimed: (jobs || []).length,
    completed,
    failed,
    jobs: results,
  };
}
