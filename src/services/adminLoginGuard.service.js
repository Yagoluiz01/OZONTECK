import crypto from "crypto";

import { env } from "../config/env.js";
import { supabaseAdmin } from "../config/supabase.js";

const DEFAULT_MAX_FAILURES = 8;
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

function getGuardSecret() {
  return (
    String(process.env.ADMIN_LOGIN_GUARD_SECRET || "").trim() ||
    String(process.env.ADMIN_SESSION_FINGERPRINT_SECRET || "").trim() ||
    env.jwtSecret
  );
}

export const ADMIN_LOGIN_GUARD_MAX_FAILURES = toPositiveInt(
  process.env.ADMIN_LOGIN_GUARD_MAX_FAILURES,
  DEFAULT_MAX_FAILURES
);

export const ADMIN_LOGIN_GUARD_WINDOW_SECONDS =
  toPositiveInt(process.env.ADMIN_LOGIN_GUARD_WINDOW_MINUTES, DEFAULT_WINDOW_MINUTES) * 60;

export const ADMIN_LOGIN_GUARD_BLOCK_SECONDS =
  toPositiveInt(process.env.ADMIN_LOGIN_GUARD_BLOCK_MINUTES, DEFAULT_BLOCK_MINUTES) * 60;

export const ADMIN_LOGIN_MIN_RESPONSE_MS = toPositiveInt(
  process.env.ADMIN_LOGIN_MIN_RESPONSE_MS,
  DEFAULT_MIN_RESPONSE_MS
);

export function hashAdminLoginIdentity(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;

  return crypto
    .createHmac("sha256", getGuardSecret())
    .update(`admin-login:${normalized}`, "utf8")
    .digest("hex");
}

function normalizeGuardRow(value) {
  const row = Array.isArray(value) ? value[0] : value;
  if (!row || typeof row !== "object") {
    return { blocked: false, retryAfterSeconds: 0, failedAttempts: 0 };
  }

  return {
    blocked: row.blocked === true,
    retryAfterSeconds: Math.max(0, Number(row.retry_after_seconds || 0)),
    failedAttempts: Math.max(0, Number(row.failed_attempts || 0)),
  };
}

function databaseError(message, cause) {
  const error = new Error(message);
  error.statusCode = 503;
  error.code = "ADMIN_LOGIN_GUARD_DATABASE_ERROR";
  error.cause = cause || null;
  return error;
}

export async function checkAdminLoginGuard(email) {
  const identityHash = hashAdminLoginIdentity(email);
  if (!identityHash) {
    return { blocked: false, retryAfterSeconds: 0, failedAttempts: 0 };
  }

  const { data, error } = await supabaseAdmin.rpc("admin_login_guard_status", {
    p_identity_hash: identityHash,
  });

  if (error) {
    console.error("[ADMIN_LOGIN_GUARD_STATUS_ERROR]", { message: error.message });
    throw databaseError("Não foi possível validar o limite de tentativas de login.", error);
  }

  return normalizeGuardRow(data);
}

export async function registerAdminLoginFailure(email) {
  const identityHash = hashAdminLoginIdentity(email);
  if (!identityHash) {
    return { blocked: false, retryAfterSeconds: 0, failedAttempts: 0 };
  }

  const { data, error } = await supabaseAdmin.rpc("admin_login_guard_failure", {
    p_identity_hash: identityHash,
    p_max_attempts: ADMIN_LOGIN_GUARD_MAX_FAILURES,
    p_window_seconds: ADMIN_LOGIN_GUARD_WINDOW_SECONDS,
    p_block_seconds: ADMIN_LOGIN_GUARD_BLOCK_SECONDS,
  });

  if (error) {
    console.error("[ADMIN_LOGIN_GUARD_FAILURE_ERROR]", { message: error.message });
    throw databaseError("Não foi possível registrar a tentativa de login.", error);
  }

  return normalizeGuardRow(data);
}

export async function registerAdminLoginSuccess(email) {
  const identityHash = hashAdminLoginIdentity(email);
  if (!identityHash) return;

  const { error } = await supabaseAdmin.rpc("admin_login_guard_success", {
    p_identity_hash: identityHash,
  });

  if (error) {
    console.error("[ADMIN_LOGIN_GUARD_SUCCESS_ERROR]", { message: error.message });
    throw databaseError("Não foi possível finalizar a proteção do login.", error);
  }
}

export async function enforceMinimumAdminLoginDuration(startedAtMs) {
  const elapsed = Date.now() - Number(startedAtMs || Date.now());
  const remaining = Math.max(0, ADMIN_LOGIN_MIN_RESPONSE_MS - elapsed);
  if (remaining > 0) {
    await new Promise((resolve) => setTimeout(resolve, remaining));
  }
}

export function setLoginRetryAfter(res, seconds) {
  const retryAfter = Math.max(1, Math.ceil(Number(seconds || ADMIN_LOGIN_GUARD_BLOCK_SECONDS)));
  res.set?.("Retry-After", String(retryAfter));
  return retryAfter;
}
