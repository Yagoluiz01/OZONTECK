import crypto from "crypto";

import { env } from "../config/env.js";
import { supabaseAdmin } from "../config/supabase.js";
import { createAdminNotification } from "./adminNotifications.service.js";
import { hashAdminLoginIdentity } from "./adminLoginGuard.service.js";

const DETECTION_WINDOW_MINUTES = 10;
const SUCCESS_LOOKBACK_MINUTES = 30;
const ATTEMPT_RETENTION_HOURS = 72;

const ACCOUNT_WARNING_FAILURES = 5;
const ACCOUNT_HIGH_FAILURES = 8;
const IP_HIGH_FAILURES = 8;
const IP_DISTINCT_ACCOUNTS_HIGH = 3;
const DISTRIBUTED_ACCOUNT_FAILURES = 6;
const DISTRIBUTED_ACCOUNT_IPS = 3;
const SUCCESS_AFTER_FAILURES = 5;

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function maskEmail(value) {
  const email = normalizeEmail(value);
  const [name, domain] = email.split("@");
  if (!name || !domain) return "conta administrativa";
  return `${name.slice(0, 2)}***@${domain}`;
}

function getSecuritySecret() {
  return (
    String(process.env.ADMIN_INTRUSION_DETECTION_SECRET || "").trim() ||
    String(process.env.ADMIN_LOGIN_GUARD_SECRET || "").trim() ||
    String(process.env.ADMIN_SESSION_FINGERPRINT_SECRET || "").trim() ||
    env.jwtSecret
  );
}

function hmac(label, value) {
  return crypto
    .createHmac("sha256", getSecuritySecret())
    .update(`${label}:${String(value || "")}`, "utf8")
    .digest("hex");
}

function getClientIp(req) {
  return String(req?.ip || req?.socket?.remoteAddress || "").trim() || "unknown";
}

function getUserAgent(req) {
  return String(req?.get?.("user-agent") || req?.headers?.["user-agent"] || "")
    .trim()
    .slice(0, 500);
}

function hashIp(req) {
  return hmac("admin-login-ip", getClientIp(req));
}

function hashUserAgent(req) {
  return hmac("admin-login-ua", getUserAgent(req) || "unknown");
}

function isoMinutesAgo(minutes) {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

function timeBucket(minutes = 15) {
  return Math.floor(Date.now() / (minutes * 60 * 1000));
}

async function findTargetAdmin(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;

  const { data, error } = await supabaseAdmin
    .from("admins")
    .select("id,email,is_master,is_active")
    .eq("email", normalized)
    .maybeSingle();

  if (error) {
    console.warn("[ADMIN_INTRUSION_TARGET_LOOKUP_ERROR]", { message: error.message });
    return null;
  }

  return data || null;
}

async function listActiveMasterAdmins() {
  const { data, error } = await supabaseAdmin
    .from("admins")
    .select("id,email")
    .eq("is_active", true)
    .eq("is_master", true);

  if (error) {
    throw new Error(`Falha ao localizar admin master: ${error.message}`);
  }

  return Array.isArray(data) ? data : [];
}

async function insertAttempt({
  identityHash,
  ipHash,
  userAgentHash,
  adminId,
  success,
  reason,
  rateLimited,
}) {
  const { error } = await supabaseAdmin.from("admin_login_security_attempts").insert({
    identity_hash: identityHash,
    ip_hash: ipHash,
    user_agent_hash: userAgentHash,
    admin_id: adminId || null,
    success: Boolean(success),
    reason: String(reason || (success ? "success" : "failure")).slice(0, 80),
    rate_limited: Boolean(rateLimited),
  });

  if (error) {
    throw new Error(`Falha ao registrar tentativa de segurança: ${error.message}`);
  }
}

async function countFailuresByIdentity(identityHash, minutes = DETECTION_WINDOW_MINUTES) {
  const { count, error } = await supabaseAdmin
    .from("admin_login_security_attempts")
    .select("id", { count: "exact", head: true })
    .eq("identity_hash", identityHash)
    .eq("success", false)
    .gte("created_at", isoMinutesAgo(minutes));

  if (error) throw new Error(error.message);
  return Number(count || 0);
}

async function recentFailuresByIp(ipHash) {
  const { data, error } = await supabaseAdmin
    .from("admin_login_security_attempts")
    .select("identity_hash")
    .eq("ip_hash", ipHash)
    .eq("success", false)
    .gte("created_at", isoMinutesAgo(DETECTION_WINDOW_MINUTES))
    .limit(250);

  if (error) throw new Error(error.message);

  const rows = Array.isArray(data) ? data : [];
  return {
    failures: rows.length,
    distinctAccounts: new Set(rows.map((row) => row.identity_hash).filter(Boolean)).size,
  };
}

async function recentFailuresByIdentity(identityHash, minutes = DETECTION_WINDOW_MINUTES) {
  const { data, error } = await supabaseAdmin
    .from("admin_login_security_attempts")
    .select("ip_hash")
    .eq("identity_hash", identityHash)
    .eq("success", false)
    .gte("created_at", isoMinutesAgo(minutes))
    .limit(250);

  if (error) throw new Error(error.message);

  const rows = Array.isArray(data) ? data : [];
  return {
    failures: rows.length,
    distinctIps: new Set(rows.map((row) => row.ip_hash).filter(Boolean)).size,
  };
}

function alertText({ eventType, targetEmail, metrics, targetIsMaster }) {
  const target = maskEmail(targetEmail);

  if (eventType === "successful_login_after_failures") {
    return {
      title: "ALERTA CRÍTICO: login após várias falhas",
      message:
        `Um login administrativo foi concluído para ${target} após ${metrics.accountFailures} ` +
        "tentativas malsucedidas recentes. Verifique imediatamente se o acesso foi legítimo.",
    };
  }

  if (eventType === "distributed_account_attack") {
    return {
      title: "ALERTA CRÍTICO: ataque distribuído detectado",
      message:
        `A conta ${target} recebeu ${metrics.accountFailures} falhas vindas de ` +
        `${metrics.distinctIps} origens diferentes em poucos minutos.`,
    };
  }

  if (eventType === "credential_stuffing") {
    return {
      title: "ALERTA CRÍTICO: possível credential stuffing",
      message:
        `Uma mesma origem tentou acessar ${metrics.distinctAccounts} contas administrativas, ` +
        `somando ${metrics.ipFailures} falhas recentes.`,
    };
  }

  if (eventType === "master_account_attack") {
    return {
      title:
  metrics.accountFailures >= ACCOUNT_HIGH_FAILURES
    ? "ALERTA CRÍTICO: conta master sob ataque"
    : "ALERTA DE SEGURANÇA: conta master sob ataque",
      message:
        `Foram detectadas ${metrics.accountFailures} tentativas malsucedidas recentes contra ` +
        `a conta master ${target}.`,
    };
  }

  return {
    title: targetIsMaster
      ? "Alerta de segurança: tentativas contra conta master"
      : "Alerta de segurança: excesso de tentativas de login",
    message:
      `Foram detectadas ${metrics.accountFailures} tentativas malsucedidas recentes contra ${target}.`,
  };
}

async function createDeduplicatedSecurityEvent({
  eventType,
  severity,
  identityHash,
  ipHash,
  adminId,
  targetEmail,
  metrics,
  targetIsMaster,
}) {
  const subjectHash =
    eventType === "credential_stuffing" ? ipHash : identityHash || ipHash;
  const dedupeKey = hmac(
    "admin-security-event",
    `${eventType}:${subjectHash}:${timeBucket(15)}`
  );

  const { data, error } = await supabaseAdmin
    .from("admin_security_events")
    .insert({
      event_type: eventType,
      severity,
      dedupe_key: dedupeKey,
      identity_hash: identityHash || null,
      ip_hash: ipHash || null,
      admin_id: adminId || null,
      metadata: {
        ...metrics,
        target_is_master: Boolean(targetIsMaster),
      },
    })
    .select("id,event_type,severity")
    .single();

  if (error) {
    // 23505 = outro request já criou o alerta deste bucket; evita tempestade de push.
    if (String(error.code || "") === "23505") return null;
    throw new Error(`Falha ao criar evento de segurança: ${error.message}`);
  }

  const masters = await listActiveMasterAdmins();
  const copy = alertText({ eventType, targetEmail, metrics, targetIsMaster });

  await Promise.all(
    masters.map(async (master) => {
      await createAdminNotification({
        type: "security_intrusion",
        title: copy.title,
        message: copy.message,
        entity_type: "security_event",
        entity_id: data.id,
        priority: severity === "critical" ? "critical" : "high",
        recipient_admin_id: master.id,
        metadata: {
          security_event_id: data.id,
          event_type: eventType,
          severity,
          ...metrics,
        },
      });
    })
  );

  await supabaseAdmin
    .from("admin_security_events")
    .update({ notified_at: new Date().toISOString() })
    .eq("id", data.id);

  return data;
}

async function detectAndNotify({
  req,
  email,
  admin,
  success,
  reason,
  rateLimited,
}) {
  const identityHash = hashAdminLoginIdentity(email);
  if (!identityHash) return;

  const ipHash = hashIp(req);
  const userAgentHash = hashUserAgent(req);
  const targetAdmin = admin || (await findTargetAdmin(email));
  const adminId = targetAdmin?.id || null;
  const targetIsMaster = targetAdmin?.is_master === true;

  // Para detectar "login bem-sucedido após falhas", contamos antes de inserir o sucesso.
  const failuresBeforeSuccess = success
    ? await countFailuresByIdentity(identityHash, SUCCESS_LOOKBACK_MINUTES)
    : 0;

  await insertAttempt({
    identityHash,
    ipHash,
    userAgentHash,
    adminId,
    success,
    reason,
    rateLimited,
  });

  if (success) {
    if (failuresBeforeSuccess >= SUCCESS_AFTER_FAILURES) {
      await createDeduplicatedSecurityEvent({
        eventType: "successful_login_after_failures",
        severity: "critical",
        identityHash,
        ipHash,
        adminId,
        targetEmail: email,
        targetIsMaster,
        metrics: { accountFailures: failuresBeforeSuccess },
      });
    }
    return;
  }

  const [accountStats, ipStats] = await Promise.all([
    recentFailuresByIdentity(identityHash),
    recentFailuresByIp(ipHash),
  ]);

  const metrics = {
    accountFailures: accountStats.failures,
    distinctIps: accountStats.distinctIps,
    ipFailures: ipStats.failures,
    distinctAccounts: ipStats.distinctAccounts,
    rateLimited: Boolean(rateLimited),
  };

  if (
    accountStats.failures >= DISTRIBUTED_ACCOUNT_FAILURES &&
    accountStats.distinctIps >= DISTRIBUTED_ACCOUNT_IPS
  ) {
    await createDeduplicatedSecurityEvent({
      eventType: "distributed_account_attack",
      severity: "critical",
      identityHash,
      ipHash,
      adminId,
      targetEmail: email,
      targetIsMaster,
      metrics,
    });
    return;
  }

  if (
    ipStats.failures >= IP_HIGH_FAILURES &&
    ipStats.distinctAccounts >= IP_DISTINCT_ACCOUNTS_HIGH
  ) {
    await createDeduplicatedSecurityEvent({
      eventType: "credential_stuffing",
      severity: "critical",
      identityHash,
      ipHash,
      adminId,
      targetEmail: email,
      targetIsMaster,
      metrics,
    });
    return;
  }

  if (targetIsMaster && accountStats.failures >= ACCOUNT_WARNING_FAILURES) {
    await createDeduplicatedSecurityEvent({
      eventType: "master_account_attack",
      severity: accountStats.failures >= ACCOUNT_HIGH_FAILURES ? "critical" : "high",
      identityHash,
      ipHash,
      adminId,
      targetEmail: email,
      targetIsMaster,
      metrics,
    });
    return;
  }

  if (accountStats.failures >= ACCOUNT_HIGH_FAILURES || rateLimited) {
    await createDeduplicatedSecurityEvent({
      eventType: "account_bruteforce",
      severity: "high",
      identityHash,
      ipHash,
      adminId,
      targetEmail: email,
      targetIsMaster,
      metrics,
    });
  }
}

export function recordAdminLoginSecurityAttempt(payload) {
  // O alerta não pode transformar indisponibilidade da central de notificações
  // em bypass ou falha do login. O bloqueio continua sendo responsabilidade dos guards.
  setImmediate(() => {
    detectAndNotify(payload).catch((error) => {
      console.error("[ADMIN_INTRUSION_DETECTION_ERROR]", {
        message: error?.message || String(error),
      });
    });
  });
}

export async function cleanupAdminLoginSecurityAttempts() {
  const cutoff = new Date(
    Date.now() - ATTEMPT_RETENTION_HOURS * 60 * 60 * 1000
  ).toISOString();

  const { error } = await supabaseAdmin
    .from("admin_login_security_attempts")
    .delete()
    .lt("created_at", cutoff);

  if (error) {
    throw new Error(`Falha ao limpar tentativas antigas: ${error.message}`);
  }
}
