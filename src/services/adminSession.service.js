import crypto from "crypto";

import { env } from "../config/env.js";
import { supabaseAdmin } from "../config/supabase.js";

const SESSION_TOKEN_BYTES = 48;
const TOKEN_HASH_PATTERN = /^[a-f0-9]{64}$/;
const DEFAULT_ABSOLUTE_TTL_HOURS = 8;
const DEFAULT_IDLE_TTL_MINUTES = 30;
const DEFAULT_TOUCH_INTERVAL_SECONDS = 120;
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function toPositiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isTruthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function normalizeSameSite(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["strict", "lax", "none"].includes(normalized)) {
    return normalized;
  }

  // Em produção o Admin e a API podem estar em hosts distintos.
  // A etapa de migração do frontend adicionará proteção CSRF antes de ativar o cookie.
  return env.nodeEnv === "production" ? "none" : "lax";
}

export const ADMIN_SESSION_ABSOLUTE_TTL_MS =
  toPositiveNumber(process.env.ADMIN_SESSION_ABSOLUTE_TTL_HOURS, DEFAULT_ABSOLUTE_TTL_HOURS) *
  60 *
  60 *
  1000;

export const ADMIN_SESSION_IDLE_TTL_MS =
  toPositiveNumber(process.env.ADMIN_SESSION_IDLE_TTL_MINUTES, DEFAULT_IDLE_TTL_MINUTES) *
  60 *
  1000;

const ADMIN_SESSION_TOUCH_INTERVAL_MS =
  toPositiveNumber(process.env.ADMIN_SESSION_TOUCH_INTERVAL_SECONDS, DEFAULT_TOUCH_INTERVAL_SECONDS) *
  1000;

export const ADMIN_MAX_ACTIVE_SESSIONS = 1;

function shouldStrictlyBindUserAgent() {
  const configured = String(process.env.ADMIN_SESSION_STRICT_USER_AGENT || "").trim();
  if (configured) return isTruthy(configured);
  return env.nodeEnv === "production";
}

function normalizeOrigin(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function getAllowedAdminOrigins() {
  const extra = String(process.env.ADMIN_CSRF_ALLOWED_ORIGINS || "")
    .split(",")
    .map(normalizeOrigin)
    .filter(Boolean);

  const configured = [
    process.env.ADMIN_FRONTEND_URL,
    process.env.ADMIN_URL,
    "https://ozonteck-admin.onrender.com",
    ...extra,
  ];

  if (env.nodeEnv !== "production") {
    configured.push(
      "http://localhost:5173",
      "http://127.0.0.1:5173",
      "http://localhost:5174",
      "http://127.0.0.1:5174"
    );
  }

  return new Set(configured.map(normalizeOrigin).filter(Boolean));
}

export function getAdminSessionCookieName() {
  const explicit = String(process.env.ADMIN_SESSION_COOKIE_NAME || "").trim();
  if (explicit) return explicit;

  // __Host- impede Domain e exige Path=/ + Secure, reduzindo risco de cookie tossing.
  return env.nodeEnv === "production" ? "__Host-oz_admin_session" : "oz_admin_session";
}

function getAcceptedCookieNames() {
  return [...new Set([getAdminSessionCookieName(), "__Host-oz_admin_session", "oz_admin_session"])];
}

function getCookieSecure() {
  if (env.nodeEnv === "production") return true;
  return isTruthy(process.env.ADMIN_SESSION_COOKIE_SECURE);
}

export function getAdminSessionCookieOptions() {
  return {
    httpOnly: true,
    secure: getCookieSecure(),
    sameSite: normalizeSameSite(process.env.ADMIN_SESSION_COOKIE_SAME_SITE),
    path: "/",
    maxAge: ADMIN_SESSION_ABSOLUTE_TTL_MS,
    priority: "high",
  };
}

function getCookieClearOptions() {
  const { httpOnly, secure, sameSite, path } = getAdminSessionCookieOptions();
  return { httpOnly, secure, sameSite, path };
}

export function setAdminSessionCookie(res, token) {
  res.cookie(getAdminSessionCookieName(), token, getAdminSessionCookieOptions());
}

export function clearAdminSessionCookie(res) {
  const options = getCookieClearOptions();
  for (const cookieName of getAcceptedCookieNames()) {
    res.clearCookie(cookieName, options);
  }
}

function parseCookies(cookieHeader) {
  const cookies = new Map();

  for (const rawPart of String(cookieHeader || "").split(";")) {
    const part = rawPart.trim();
    if (!part) continue;

    const separatorIndex = part.indexOf("=");
    if (separatorIndex <= 0) continue;

    const key = part.slice(0, separatorIndex).trim();
    const rawValue = part.slice(separatorIndex + 1).trim();

    if (!key || cookies.has(key)) continue;

    try {
      cookies.set(key, decodeURIComponent(rawValue));
    } catch {
      cookies.set(key, rawValue);
    }
  }

  return cookies;
}

export function getAdminSessionTokenFromRequest(req) {
  const cookies = parseCookies(req.headers?.cookie);

  for (const cookieName of getAcceptedCookieNames()) {
    const value = String(cookies.get(cookieName) || "").trim();
    if (value) return value;
  }

  return null;
}

function hashSessionToken(token) {
  return crypto.createHash("sha256").update(String(token), "utf8").digest("hex");
}

function deriveCsrfTokenFromTokenHash(tokenHash) {
  const csrfSecret =
    String(process.env.ADMIN_CSRF_SECRET || "").trim() ||
    String(process.env.ADMIN_SESSION_FINGERPRINT_SECRET || "").trim() ||
    env.jwtSecret;

  return crypto
    .createHmac("sha256", csrfSecret)
    .update(`admin-csrf-v2:${String(tokenHash || "")}`, "utf8")
    .digest("base64url");
}

function hashRequestAttribute(value) {
  const normalized = String(value || "").trim();
  if (!normalized) return null;

  const fingerprintSecret =
    String(process.env.ADMIN_SESSION_FINGERPRINT_SECRET || "").trim() || env.jwtSecret;

  return crypto
    .createHmac("sha256", fingerprintSecret)
    .update(normalized, "utf8")
    .digest("hex");
}

function getRequestFingerprint(req) {
  return {
    ip_hash: hashRequestAttribute(req.ip || req.socket?.remoteAddress || ""),
    user_agent_hash: hashRequestAttribute(req.get?.("user-agent") || req.headers?.["user-agent"] || ""),
  };
}

function createSessionError(message, statusCode = 401, code = "ADMIN_SESSION_INVALID") {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function getSessionTimes(nowMs = Date.now()) {
  const absoluteExpiresMs = nowMs + ADMIN_SESSION_ABSOLUTE_TTL_MS;
  const idleExpiresMs = Math.min(absoluteExpiresMs, nowMs + ADMIN_SESSION_IDLE_TTL_MS);

  return {
    createdAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(absoluteExpiresMs).toISOString(),
    idleExpiresAt: new Date(idleExpiresMs).toISOString(),
  };
}

async function getCurrentAdminSessionVersion(admin) {
  const direct = Number(admin?.session_version);
  if (Number.isSafeInteger(direct) && direct >= 1) {
    return direct;
  }

  const { data, error } = await supabaseAdmin
    .from("admins")
    .select("id,session_version")
    .eq("id", admin?.id)
    .maybeSingle();

  if (error || !data?.id) {
    console.error("[ADMIN_SESSION_VERSION_LOOKUP_ERROR]", {
      admin_id: admin?.id || null,
      message: error?.message || "Administrador não encontrado.",
    });
    throw createSessionError(
      "Não foi possível validar a versão de segurança do administrador.",
      503,
      "ADMIN_SESSION_VERSION_LOOKUP_FAILED"
    );
  }

  const version = Number(data.session_version);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw createSessionError(
      "Versão de segurança administrativa inválida.",
      503,
      "ADMIN_SESSION_VERSION_INVALID"
    );
  }

  return version;
}

const SINGLE_SESSION_REVOKE_REASON = "concurrent_session_limit";

export async function createAdminSession({ req, admin, authUserId = null }) {
  if (!admin?.id) {
    throw createSessionError(
      "Administrador inválido para criação de sessão.",
      500,
      "ADMIN_SESSION_ADMIN_MISSING"
    );
  }

  // A política de segurança do painel é uma única sessão ativa por administrador.
  // A exclusividade é aplicada atomicamente no Postgres para impedir race conditions.
  const token = crypto.randomBytes(SESSION_TOKEN_BYTES).toString("base64url");
  const tokenHash = hashSessionToken(token);
  const csrfToken = deriveCsrfTokenFromTokenHash(tokenHash);
  const csrfTokenHash = hashSessionToken(csrfToken);
  const times = getSessionTimes();
  const fingerprint = getRequestFingerprint(req);

  const { data, error } = await supabaseAdmin.rpc("create_admin_single_session", {
    p_admin_id: admin.id,
    p_token_hash: tokenHash,
    p_csrf_token_hash: csrfTokenHash,
    p_created_at: times.createdAt,
    p_expires_at: times.expiresAt,
    p_idle_expires_at: times.idleExpiresAt,
    p_ip_hash: fingerprint.ip_hash,
    p_user_agent_hash: fingerprint.user_agent_hash,
  });

  const row = Array.isArray(data) ? data[0] : data;

  if (error || !row?.id) {
    console.error("[ADMIN_SINGLE_SESSION_CREATE_ERROR]", {
      admin_id: admin.id,
      message: error?.message || "Sessão não retornada pelo banco.",
    });

    throw createSessionError(
      "Não foi possível iniciar uma sessão administrativa segura.",
      503,
      "ADMIN_SESSION_CREATE_FAILED"
    );
  }

  // Mantém authUserId no contrato da função por compatibilidade com os chamadores,
  // mas o banco usa o auth_user_id canônico da tabela admins.
  void authUserId;
  void SINGLE_SESSION_REVOKE_REASON;

  return {
    token,
    csrfToken,
    session: {
      id: row.id,
      admin_id: row.admin_id,
      auth_user_id: row.auth_user_id,
      session_version: row.session_version,
      created_at: row.created_at,
      last_seen_at: row.last_seen_at,
      expires_at: row.expires_at,
      idle_expires_at: row.idle_expires_at,
    },
    revokedSessions: Number(row.revoked_sessions || 0),
  };
}

async function revokeAdminSessionById(sessionId, reason = "revoked") {
  if (!sessionId) return;

  const { error } = await supabaseAdmin
    .from("admin_sessions")
    .update({ revoked_at: new Date().toISOString(), revoke_reason: String(reason || "revoked").slice(0, 120) })
    .eq("id", sessionId)
    .is("revoked_at", null);

  if (error) {
    console.error("[ADMIN_SESSION_REVOKE_ERROR]", {
      session_id: sessionId,
      message: error.message,
    });
  }
}

export async function validateAdminSessionToken(token, { req } = {}) {
  const normalizedToken = String(token || "").trim();
  if (normalizedToken.length < 40 || normalizedToken.length > 256) {
    throw createSessionError("Sessão administrativa inválida.");
  }

  const tokenHash = hashSessionToken(normalizedToken);
  if (!TOKEN_HASH_PATTERN.test(tokenHash)) {
    throw createSessionError("Sessão administrativa inválida.");
  }

  const { data, error } = await supabaseAdmin
    .from("admin_sessions")
    .select(
      "id,admin_id,auth_user_id,session_version,token_hash,created_at,last_seen_at,expires_at,idle_expires_at,revoked_at,revoke_reason,ip_hash,user_agent_hash,csrf_token_hash"
    )
    .eq("token_hash", tokenHash)
    .maybeSingle();

  if (error) {
    console.error("[ADMIN_SESSION_LOOKUP_ERROR]", { message: error.message });
    throw createSessionError(
      "Não foi possível validar a sessão administrativa.",
      503,
      "ADMIN_SESSION_LOOKUP_FAILED"
    );
  }

  if (!data) {
    throw createSessionError(
      "Sessão administrativa inválida ou encerrada.",
      401,
      "ADMIN_SESSION_INVALID"
    );
  }

  if (data.revoked_at) {
    const revokeReason = String(data.revoke_reason || "").trim();

    if (revokeReason === "concurrent_session_limit") {
      throw createSessionError(
        "Um novo login foi realizado nesta conta. Esta sessão foi encerrada por segurança.",
        401,
        "ADMIN_SESSION_REPLACED"
      );
    }

    throw createSessionError(
      "Sessão administrativa inválida ou encerrada.",
      401,
      "ADMIN_SESSION_REVOKED"
    );
  }

  const nowMs = Date.now();
  const absoluteExpiresMs = Date.parse(data.expires_at);
  const idleExpiresMs = Date.parse(data.idle_expires_at);

  if (
    !Number.isFinite(absoluteExpiresMs) ||
    !Number.isFinite(idleExpiresMs) ||
    nowMs >= absoluteExpiresMs ||
    nowMs >= idleExpiresMs
  ) {
    await revokeAdminSessionById(data.id, "expired");
    throw createSessionError("Sessão administrativa expirada.", 401, "ADMIN_SESSION_EXPIRED");
  }

  // Fingerprints servem para telemetria; não prendemos a sessão ao IP/UA para evitar
  // expulsões legítimas em redes móveis, proxies e atualizações de navegador.
  if (req) {
    const currentFingerprint = getRequestFingerprint(req);
    const fingerprintChanged =
      (data.user_agent_hash &&
        currentFingerprint.user_agent_hash &&
        data.user_agent_hash !== currentFingerprint.user_agent_hash) ||
      (data.ip_hash && currentFingerprint.ip_hash && data.ip_hash !== currentFingerprint.ip_hash);

    if (fingerprintChanged) {
      const userAgentChanged =
        data.user_agent_hash &&
        currentFingerprint.user_agent_hash &&
        data.user_agent_hash !== currentFingerprint.user_agent_hash;

      console.warn("[ADMIN_SESSION_FINGERPRINT_CHANGED]", {
        session_id: data.id,
        admin_id: data.admin_id,
        user_agent_changed: Boolean(userAgentChanged),
        ip_changed: Boolean(
          data.ip_hash &&
          currentFingerprint.ip_hash &&
          data.ip_hash !== currentFingerprint.ip_hash
        ),
      });

      if (userAgentChanged && shouldStrictlyBindUserAgent()) {
        await revokeAdminSessionById(data.id, "user_agent_changed");
        throw createSessionError(
          "A sessão administrativa mudou de dispositivo e foi encerrada.",
          401,
          "ADMIN_SESSION_USER_AGENT_CHANGED"
        );
      }
    }

    const lastSeenMs = Date.parse(data.last_seen_at);
    if (!Number.isFinite(lastSeenMs) || nowMs - lastSeenMs >= ADMIN_SESSION_TOUCH_INTERVAL_MS) {
      const nextIdleExpiresMs = Math.min(absoluteExpiresMs, nowMs + ADMIN_SESSION_IDLE_TTL_MS);
      const { error: touchError } = await supabaseAdmin
        .from("admin_sessions")
        .update({
          last_seen_at: new Date(nowMs).toISOString(),
          idle_expires_at: new Date(nextIdleExpiresMs).toISOString(),
        })
        .eq("id", data.id)
        .is("revoked_at", null);

      if (touchError) {
        console.error("[ADMIN_SESSION_TOUCH_ERROR]", {
          session_id: data.id,
          message: touchError.message,
        });
      } else {
        data.last_seen_at = new Date(nowMs).toISOString();
        data.idle_expires_at = new Date(nextIdleExpiresMs).toISOString();
      }
    }
  }

  return data;
}

function getRequestOrigin(req) {
  const origin = normalizeOrigin(req.get?.("origin") || req.headers?.origin || "");
  if (origin) return origin;

  const referer = String(req.get?.("referer") || req.headers?.referer || "").trim();
  if (!referer) return "";

  try {
    return normalizeOrigin(new URL(referer).origin);
  } catch {
    return "";
  }
}

export function assertAdminCsrfProtection(req, session) {
  const method = String(req.method || "GET").toUpperCase();
  if (SAFE_METHODS.has(method)) return;

  const requestOrigin = getRequestOrigin(req);
  const allowedOrigins = getAllowedAdminOrigins();

  if (!requestOrigin || !allowedOrigins.has(requestOrigin)) {
    throw createSessionError(
      "Origem da requisição administrativa não autorizada.",
      403,
      "ADMIN_CSRF_ORIGIN_REJECTED"
    );
  }

  const suppliedToken = String(req.get?.("x-csrf-token") || req.headers?.["x-csrf-token"] || "").trim();
  if (!suppliedToken || suppliedToken.length > 256 || !session?.csrf_token_hash) {
    throw createSessionError(
      "Proteção CSRF ausente ou inválida.",
      403,
      "ADMIN_CSRF_TOKEN_MISSING"
    );
  }

  const suppliedHash = hashSessionToken(suppliedToken);
  const expectedHash = String(session.csrf_token_hash || "");

  if (suppliedHash.length !== expectedHash.length) {
    throw createSessionError("Proteção CSRF inválida.", 403, "ADMIN_CSRF_TOKEN_INVALID");
  }

  const matches = crypto.timingSafeEqual(
    Buffer.from(suppliedHash, "utf8"),
    Buffer.from(expectedHash, "utf8")
  );

  if (!matches) {
    throw createSessionError("Proteção CSRF inválida.", 403, "ADMIN_CSRF_TOKEN_INVALID");
  }
}


export async function getAdminSessionCsrfToken(sessionId) {
  const normalizedSessionId = String(sessionId || "").trim();
  if (!normalizedSessionId) {
    throw createSessionError(
      "Sessão administrativa inválida.",
      401,
      "ADMIN_SESSION_ID_MISSING"
    );
  }

  const { data, error } = await supabaseAdmin
    .from("admin_sessions")
    .select("id,token_hash,csrf_token_hash,expires_at,idle_expires_at,revoked_at")
    .eq("id", normalizedSessionId)
    .maybeSingle();

  if (error) {
    console.error("[ADMIN_SESSION_CSRF_LOOKUP_ERROR]", {
      session_id: normalizedSessionId,
      message: error.message,
    });

    throw createSessionError(
      "Não foi possível recuperar a proteção da sessão administrativa.",
      503,
      "ADMIN_SESSION_CSRF_LOOKUP_FAILED"
    );
  }

  if (!data?.id || data.revoked_at || !TOKEN_HASH_PATTERN.test(String(data.token_hash || ""))) {
    throw createSessionError(
      "Sessão administrativa inválida ou encerrada.",
      401,
      "ADMIN_SESSION_INVALID"
    );
  }

  const csrfToken = deriveCsrfTokenFromTokenHash(data.token_hash);
  const csrfTokenHash = hashSessionToken(csrfToken);

  // Sessões criadas na Etapa 1 tinham CSRF aleatório. Na primeira leitura após
  // o upgrade, convertemos o hash para o token determinístico ligado à sessão.
  // Chamadas concorrentes derivam o mesmo valor, evitando corrida de rotação.
  if (String(data.csrf_token_hash || "") !== csrfTokenHash) {
    const { error: updateError } = await supabaseAdmin
      .from("admin_sessions")
      .update({ csrf_token_hash: csrfTokenHash })
      .eq("id", normalizedSessionId)
      .is("revoked_at", null);

    if (updateError) {
      console.error("[ADMIN_SESSION_CSRF_REPAIR_ERROR]", {
        session_id: normalizedSessionId,
        message: updateError.message,
      });

      throw createSessionError(
        "Não foi possível renovar a proteção da sessão administrativa.",
        503,
        "ADMIN_SESSION_CSRF_REPAIR_FAILED"
      );
    }
  }

  return { csrfToken, session: data };
}

export async function revokeAdminSessionToken(token, reason = "logout") {
  const normalizedToken = String(token || "").trim();
  if (!normalizedToken) return false;

  const tokenHash = hashSessionToken(normalizedToken);
  const { data, error } = await supabaseAdmin
    .from("admin_sessions")
    .update({ revoked_at: new Date().toISOString(), revoke_reason: String(reason || "logout").slice(0, 120) })
    .eq("token_hash", tokenHash)
    .is("revoked_at", null)
    .select("id")
    .maybeSingle();

  if (error) {
    console.error("[ADMIN_SESSION_LOGOUT_ERROR]", { message: error.message });
    throw createSessionError(
      "Não foi possível encerrar a sessão administrativa.",
      503,
      "ADMIN_SESSION_LOGOUT_FAILED"
    );
  }

  return Boolean(data?.id);
}

export async function revokeAllAdminSessions(adminId, reason = "logout_all") {
  if (!adminId) return 0;

  const { data, error } = await supabaseAdmin
    .from("admin_sessions")
    .update({ revoked_at: new Date().toISOString(), revoke_reason: String(reason || "logout_all").slice(0, 120) })
    .eq("admin_id", adminId)
    .is("revoked_at", null)
    .select("id");

  if (error) {
    console.error("[ADMIN_SESSION_LOGOUT_ALL_ERROR]", {
      admin_id: adminId,
      message: error.message,
    });
    throw createSessionError(
      "Não foi possível encerrar as sessões administrativas.",
      503,
      "ADMIN_SESSION_LOGOUT_ALL_FAILED"
    );
  }

  return Array.isArray(data) ? data.length : 0;
}

export async function revokeAdminSessionId(sessionId, reason = "revoked") {
  await revokeAdminSessionById(sessionId, reason);
}

export async function invalidateAdminSessionsAfterPasswordReset(authUserId) {
  const normalizedAuthUserId = String(authUserId || "").trim();
  if (!normalizedAuthUserId) {
    throw createSessionError(
      "Identidade de autenticação inválida para revogação.",
      500,
      "ADMIN_SESSION_AUTH_USER_MISSING"
    );
  }

  const { data, error } = await supabaseAdmin.rpc(
    "bump_admin_session_version_by_auth_user",
    { p_auth_user_id: normalizedAuthUserId }
  );

  if (error) {
    console.error("[ADMIN_SESSION_PASSWORD_RESET_REVOKE_ERROR]", {
      auth_user_id: normalizedAuthUserId,
      message: error.message,
    });
    throw createSessionError(
      "A senha foi alterada, mas não foi possível invalidar as sessões antigas.",
      503,
      "ADMIN_SESSION_PASSWORD_RESET_REVOKE_FAILED"
    );
  }

  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.admin_id) {
    throw createSessionError(
      "Administrador não encontrado para invalidação de sessões.",
      500,
      "ADMIN_SESSION_PASSWORD_RESET_ADMIN_NOT_FOUND"
    );
  }

  return {
    adminId: row.admin_id,
    newSessionVersion: Number(row.new_session_version || 0),
    revokedSessions: Number(row.revoked_sessions || 0),
  };
}

