import crypto from "crypto";

import { supabaseAdmin } from "../config/supabase.js";
import { createAdminNotification } from "./adminNotifications.service.js";
import { getAffiliateSecurityKey } from "./affiliateSecurityKey.service.js";

const WINDOW_MINUTES = 10;
const ALERT_FAILURES = 5;
const CRITICAL_FAILURES = 8;
const DISTINCT_ACCOUNTS_THRESHOLD = 3;
const CLEANUP_INTERVAL_MS = 15 * 60 * 1000;

let lastCleanupAttemptAt = 0;

function intrusionKey() {
  return getAffiliateSecurityKey("intrusion-telemetry", "AFFILIATE_INTRUSION_SECRET");
}

function hmac(value) {
  return crypto
    .createHmac("sha256", intrusionKey())
    .update(String(value || ""), "utf8")
    .digest("hex");
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function maskEmail(email) {
  const value = normalizeEmail(email);
  const [name, domain] = value.split("@");
  if (!name || !domain) return "conta não identificada";
  return `${name.slice(0, 2)}***@${domain}`;
}

async function findAffiliate(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;

  const { data, error } = await supabaseAdmin
    .from("affiliates")
    .select("id,email,status,access_enabled")
    .ilike("email", normalized)
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("[AFFILIATE_SECURITY_AFFILIATE_LOOKUP_ERROR]", {
      message: error.message,
    });
    return null;
  }

  return data || null;
}

async function cleanupTelemetryIfNeeded() {
  const now = Date.now();
  if (now - lastCleanupAttemptAt < CLEANUP_INTERVAL_MS) return;
  lastCleanupAttemptAt = now;

  try {
    const { error } = await supabaseAdmin.rpc("cleanup_affiliate_security_telemetry");
    if (error && error.code !== "PGRST202") {
      console.error("[AFFILIATE_SECURITY_CLEANUP_ERROR]", { message: error.message });
    }
  } catch (error) {
    console.error("[AFFILIATE_SECURITY_CLEANUP_ERROR]", {
      message: error?.message || String(error),
    });
  }
}

async function notifyMasters({ event, affiliate, email, metrics }) {
  const { data: masters, error } = await supabaseAdmin
    .from("admins")
    .select("id,email,is_master,is_active")
    .eq("is_master", true)
    .eq("is_active", true);

  if (error || !Array.isArray(masters)) return;

  const severity = metrics.failures >= CRITICAL_FAILURES ? "critical" : "high";
  const title =
    event === "credential_stuffing"
      ? "ALERTA CRÍTICO: possível ataque a contas de afiliados"
      : severity === "critical"
        ? "ALERTA CRÍTICO: conta de afiliado sob ataque"
        : "ALERTA DE SEGURANÇA: conta de afiliado sob ataque";

  const message =
    event === "credential_stuffing"
      ? `Uma mesma origem tentou acessar ${metrics.distinct_accounts} contas de afiliados, somando ${metrics.ip_failures} falhas recentes.`
      : `Foram detectadas ${metrics.failures} tentativas malsucedidas contra ${maskEmail(email)}.`;

  const deliveries = await Promise.allSettled(
    masters.map((master) =>
      createAdminNotification({
        type: "affiliate_security_intrusion",
        title,
        message,
        priority: severity,
        recipient_admin_id: master.id,
        metadata: {
          event_type: event,
          severity,
          affiliate_id: affiliate?.id || null,
          failures: metrics.failures,
          ip_failures: metrics.ip_failures,
          distinct_accounts: metrics.distinct_accounts,
        },
      })
    )
  );

  deliveries.forEach((delivery, index) => {
    if (delivery.status === "rejected") {
      console.error("[AFFILIATE_SECURITY_NOTIFICATION_ERROR]", {
        admin_id: masters[index]?.id || null,
        message: delivery.reason?.message || String(delivery.reason),
      });
    }
  });
}

export async function recordAffiliateLoginAttempt({
  req,
  email,
  success,
  reason = null,
}) {
  try {
    void cleanupTelemetryIfNeeded();

    const normalizedEmail = normalizeEmail(email);
    const affiliate = await findAffiliate(normalizedEmail);
    const identityHash = hmac(`identity:${normalizedEmail || "missing"}`);
    const ipHash = hmac(`ip:${req?.ip || req?.socket?.remoteAddress || "unknown"}`);
    const uaHash = hmac(
      `ua:${String(req?.get?.("user-agent") || req?.headers?.["user-agent"] || "").slice(0, 512)}`
    );

    const { error: insertAttemptError } = await supabaseAdmin
      .from("affiliate_login_security_attempts")
      .insert({
        affiliate_id: affiliate?.id || null,
        identity_hash: identityHash,
        ip_hash: ipHash,
        user_agent_hash: uaHash,
        success: Boolean(success),
        reason: String(reason || (success ? "success" : "invalid_credentials")).slice(0, 80),
      });

    if (insertAttemptError) {
      console.error("[AFFILIATE_SECURITY_ATTEMPT_ERROR]", {
        message: insertAttemptError.message,
      });
      return;
    }

    if (success) return;

    const since = new Date(Date.now() - WINDOW_MINUTES * 60 * 1000).toISOString();

    const [{ count: failures, error: countError }, { data: ipRows, error: ipError }] =
      await Promise.all([
        supabaseAdmin
          .from("affiliate_login_security_attempts")
          .select("id", { count: "exact", head: true })
          .eq("identity_hash", identityHash)
          .eq("success", false)
          .gte("created_at", since),
        supabaseAdmin
          .from("affiliate_login_security_attempts")
          .select("identity_hash")
          .eq("ip_hash", ipHash)
          .eq("success", false)
          .gte("created_at", since),
      ]);

    if (countError || ipError) {
      console.error("[AFFILIATE_SECURITY_METRIC_ERROR]", {
        count: countError?.message || null,
        ip: ipError?.message || null,
      });
      return;
    }

    const rows = Array.isArray(ipRows) ? ipRows : [];
    const ipFailures = rows.length;
    const distinctAccounts = new Set(rows.map((row) => row.identity_hash)).size;

    let eventType = null;
    if (ipFailures >= CRITICAL_FAILURES && distinctAccounts >= DISTINCT_ACCOUNTS_THRESHOLD) {
      eventType = "credential_stuffing";
    } else if (Number(failures || 0) >= ALERT_FAILURES) {
      eventType = "affiliate_bruteforce";
    }

    if (!eventType) return;

    const severity =
      eventType === "credential_stuffing" || Number(failures || 0) >= CRITICAL_FAILURES
        ? "critical"
        : "high";

    const bucket = Math.floor(Date.now() / (15 * 60 * 1000));
    const dedupeKey = hmac(
      `${eventType}:${severity}:${eventType === "credential_stuffing" ? ipHash : identityHash}:${bucket}`
    );

    const { data: inserted, error } = await supabaseAdmin
      .from("affiliate_security_events")
      .insert({
        affiliate_id: affiliate?.id || null,
        event_type: eventType,
        severity,
        dedupe_key: dedupeKey,
        identity_hash: identityHash,
        ip_hash: ipHash,
        metadata: {
          failures: Number(failures || 0),
          ip_failures: ipFailures,
          distinct_accounts: distinctAccounts,
        },
      })
      .select("id")
      .maybeSingle();

    if (error) {
      if (error.code === "23505") return;
      console.error("[AFFILIATE_SECURITY_EVENT_ERROR]", { message: error.message });
      return;
    }

    if (inserted?.id) {
      await notifyMasters({
        event: eventType,
        affiliate,
        email: normalizedEmail,
        metrics: {
          failures: Number(failures || 0),
          ip_failures: ipFailures,
          distinct_accounts: distinctAccounts,
        },
      });

      await supabaseAdmin
        .from("affiliate_security_events")
        .update({ notified_at: new Date().toISOString() })
        .eq("id", inserted.id);
    }
  } catch (error) {
    console.error("[AFFILIATE_INTRUSION_DETECTION_ERROR]", {
      message: error?.message || String(error),
    });
  }
}
