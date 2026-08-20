import crypto from "crypto";

import { supabaseAdmin } from "../config/supabase.js";
import { getAffiliateSecurityKey } from "./affiliateSecurityKey.service.js";

const DEFAULT_ACCOUNT_MAX_FAILURES = 8;
const DEFAULT_IP_MAX_FAILURES = 20;
const DEFAULT_WINDOW_MINUTES = 15;
const DEFAULT_BLOCK_MINUTES = 15;
const DEFAULT_MIN_RESPONSE_MS = 550;

function toPositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function guardKey() {
  return getAffiliateSecurityKey("login-guard", "AFFILIATE_LOGIN_GUARD_SECRET");
}

function hmac(value) {
  return crypto
    .createHmac("sha256", guardKey())
    .update(String(value || ""), "utf8")
    .digest("hex");
}

export const AFFILIATE_LOGIN_GUARD_ACCOUNT_MAX_FAILURES = toPositiveInt(
  process.env.AFFILIATE_LOGIN_GUARD_ACCOUNT_MAX_FAILURES ||
    process.env.AFFILIATE_LOGIN_GUARD_MAX_FAILURES,
  DEFAULT_ACCOUNT_MAX_FAILURES
);

export const AFFILIATE_LOGIN_GUARD_IP_MAX_FAILURES = toPositiveInt(
  process.env.AFFILIATE_LOGIN_GUARD_IP_MAX_FAILURES,
  DEFAULT_IP_MAX_FAILURES
);

export const AFFILIATE_LOGIN_GUARD_WINDOW_MINUTES = toPositiveInt(
  process.env.AFFILIATE_LOGIN_GUARD_WINDOW_MINUTES,
  DEFAULT_WINDOW_MINUTES
);

export const AFFILIATE_LOGIN_GUARD_BLOCK_MINUTES = toPositiveInt(
  process.env.AFFILIATE_LOGIN_GUARD_BLOCK_MINUTES,
  DEFAULT_BLOCK_MINUTES
);

export const AFFILIATE_LOGIN_MIN_RESPONSE_MS = toPositiveInt(
  process.env.AFFILIATE_LOGIN_MIN_RESPONSE_MS,
  DEFAULT_MIN_RESPONSE_MS
);

export function hashAffiliateLoginIdentity(email) {
  const normalized = normalizeEmail(email);
  return hmac(`affiliate-login:${normalized || "missing"}`);
}

export function hashAffiliateLoginIp(req) {
  const ip = String(req?.ip || req?.socket?.remoteAddress || "unknown").trim();
  return hmac(`affiliate-ip:${ip}`);
}

function normalizeGuardRow(value) {
  const row = Array.isArray(value) ? value[0] : value;
  if (!row || typeof row !== "object") {
    return {
      blocked: false,
      failedAttempts: 0,
      blockedUntil: null,
      retryAfterSeconds: 0,
    };
  }

  const blockedUntil = row.blocked_until || null;
  const blockedUntilMs = blockedUntil ? Date.parse(blockedUntil) : NaN;
  const retryAfterSeconds = Number.isFinite(blockedUntilMs)
    ? Math.max(0, Math.ceil((blockedUntilMs - Date.now()) / 1000))
    : 0;

  return {
    blocked: row.blocked === true,
    failedAttempts: Math.max(0, Number(row.failed_attempts || 0)),
    blockedUntil,
    retryAfterSeconds,
  };
}

function databaseError(message, cause) {
  const error = new Error(message);
  error.statusCode = 503;
  error.code = "AFFILIATE_LOGIN_GUARD_DATABASE_ERROR";
  error.cause = cause || null;
  return error;
}

async function status(subjectHash) {
  const { data, error } = await supabaseAdmin.rpc("affiliate_login_guard_status", {
    p_subject_hash: subjectHash,
  });

  if (error) {
    console.error("[AFFILIATE_LOGIN_GUARD_STATUS_ERROR]", { message: error.message });
    throw databaseError("Proteção de login temporariamente indisponível.", error);
  }

  return normalizeGuardRow(data);
}

export async function checkAffiliateLoginGuard({ email, req }) {
  const [identity, ip] = await Promise.all([
    status(hashAffiliateLoginIdentity(email)),
    status(hashAffiliateLoginIp(req)),
  ]);

  return {
    blocked: Boolean(identity.blocked || ip.blocked),
    retryAfterSeconds: Math.max(
      Number(identity.retryAfterSeconds || 0),
      Number(ip.retryAfterSeconds || 0)
    ),
    identity,
    ip,
  };
}

async function failure(subjectHash, maxFailures) {
  const { data, error } = await supabaseAdmin.rpc("affiliate_login_guard_failure", {
    p_subject_hash: subjectHash,
    p_max_failures: maxFailures,
    p_window_minutes: AFFILIATE_LOGIN_GUARD_WINDOW_MINUTES,
    p_block_minutes: AFFILIATE_LOGIN_GUARD_BLOCK_MINUTES,
  });

  if (error) {
    console.error("[AFFILIATE_LOGIN_GUARD_FAILURE_ERROR]", { message: error.message });
    throw databaseError("Proteção de login temporariamente indisponível.", error);
  }

  return normalizeGuardRow(data);
}

export async function registerAffiliateLoginFailure({ email, req }) {
  const [identity, ip] = await Promise.all([
    failure(
      hashAffiliateLoginIdentity(email),
      AFFILIATE_LOGIN_GUARD_ACCOUNT_MAX_FAILURES
    ),
    failure(hashAffiliateLoginIp(req), AFFILIATE_LOGIN_GUARD_IP_MAX_FAILURES),
  ]);

  return {
    blocked: Boolean(identity.blocked || ip.blocked),
    retryAfterSeconds: Math.max(
      Number(identity.retryAfterSeconds || 0),
      Number(ip.retryAfterSeconds || 0)
    ),
    identity,
    ip,
  };
}

export async function registerAffiliateLoginSuccess({ email }) {
  const { error } = await supabaseAdmin.rpc("affiliate_login_guard_success", {
    p_subject_hash: hashAffiliateLoginIdentity(email),
  });

  if (error) {
    console.error("[AFFILIATE_LOGIN_GUARD_SUCCESS_ERROR]", { message: error.message });
    throw databaseError("Não foi possível finalizar a proteção do login.", error);
  }
}

export async function enforceMinimumAffiliateLoginDuration(startedAtMs) {
  const elapsed = Date.now() - Number(startedAtMs || Date.now());
  const remaining = Math.max(0, AFFILIATE_LOGIN_MIN_RESPONSE_MS - elapsed);
  if (remaining > 0) {
    await new Promise((resolve) => setTimeout(resolve, remaining));
  }
}

export function setAffiliateLoginRetryAfter(res, seconds) {
  const fallback = AFFILIATE_LOGIN_GUARD_BLOCK_MINUTES * 60;
  const retryAfter = Math.max(1, Math.ceil(Number(seconds || fallback)));
  res.set?.("Retry-After", String(retryAfter));
  return retryAfter;
}
