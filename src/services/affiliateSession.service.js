import crypto from "crypto";

import { env } from "../config/env.js";
import { supabaseAdmin } from "../config/supabase.js";
import { getAffiliateSecurityKey } from "./affiliateSecurityKey.service.js";

const SESSION_TOKEN_BYTES = 48;
const TOKEN_HASH_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const ABSOLUTE_TTL_MS =
  Number(process.env.AFFILIATE_SESSION_ABSOLUTE_TTL_HOURS || 12) * 60 * 60 * 1000;
const IDLE_TTL_MS =
  Number(process.env.AFFILIATE_SESSION_IDLE_TTL_MINUTES || 60) * 60 * 1000;
const TOUCH_INTERVAL_MS =
  Number(process.env.AFFILIATE_SESSION_TOUCH_INTERVAL_SECONDS || 120) * 1000;

function normalizeOrigin(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function normalizeSameSite(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["strict", "lax", "none"].includes(normalized)) return normalized;
  return env.nodeEnv === "production" ? "none" : "lax";
}

function isTruthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function getAllowedOrigins() {
  const extra = String(process.env.AFFILIATE_CSRF_ALLOWED_ORIGINS || "")
    .split(",")
    .map(normalizeOrigin)
    .filter(Boolean);

  const origins = [
    process.env.STORE_FRONTEND_URL,
    process.env.FRONTEND_URL,
    "https://ozonteck-loja.onrender.com",
    ...extra,
  ];

  if (env.nodeEnv !== "production") {
    origins.push(
      "http://localhost:5500",
      "http://127.0.0.1:5500",
      "http://localhost:5173",
      "http://127.0.0.1:5173",
      "http://localhost:5174",
      "http://127.0.0.1:5174"
    );
  }

  return new Set(origins.map(normalizeOrigin).filter(Boolean));
}

export function getAffiliateSessionCookieName() {
  const explicit = String(process.env.AFFILIATE_SESSION_COOKIE_NAME || "").trim();
  if (explicit) return explicit;
  return env.nodeEnv === "production"
    ? "__Host-oz_affiliate_session"
    : "oz_affiliate_session";
}

function getAcceptedCookieNames() {
  return [
    ...new Set([
      getAffiliateSessionCookieName(),
      "__Host-oz_affiliate_session",
      "oz_affiliate_session",
    ]),
  ];
}

function getCookieSecure() {
  if (env.nodeEnv === "production") return true;
  return isTruthy(process.env.AFFILIATE_SESSION_COOKIE_SECURE);
}

export function getAffiliateSessionCookieOptions() {
  return {
    httpOnly: true,
    secure: getCookieSecure(),
    sameSite: normalizeSameSite(process.env.AFFILIATE_SESSION_COOKIE_SAME_SITE),
    path: "/",
    maxAge: ABSOLUTE_TTL_MS,
    priority: "high",
  };
}

export function setAffiliateSessionCookie(res, token) {
  res.cookie(getAffiliateSessionCookieName(), token, getAffiliateSessionCookieOptions());
}

export function clearAffiliateSessionCookie(res) {
  const { httpOnly, secure, sameSite, path } = getAffiliateSessionCookieOptions();
  for (const cookieName of getAcceptedCookieNames()) {
    res.clearCookie(cookieName, { httpOnly, secure, sameSite, path });
  }
}

function parseCookies(header) {
  const result = new Map();

  for (const rawPart of String(header || "").split(";")) {
    const part = rawPart.trim();
    if (!part) continue;
    const index = part.indexOf("=");
    if (index <= 0) continue;

    const key = part.slice(0, index).trim();
    const rawValue = part.slice(index + 1).trim();
    if (!key || result.has(key)) continue;

    try {
      result.set(key, decodeURIComponent(rawValue));
    } catch {
      result.set(key, rawValue);
    }
  }

  return result;
}

export function getAffiliateSessionTokenFromRequest(req) {
  const cookies = parseCookies(req.headers?.cookie);

  for (const cookieName of getAcceptedCookieNames()) {
    const value = String(cookies.get(cookieName) || "").trim();
    if (value) return value;
  }

  return null;
}

function hashToken(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function getCsrfKey() {
  return getAffiliateSecurityKey("csrf", "AFFILIATE_CSRF_SECRET");
}

function getFingerprintKey() {
  return getAffiliateSecurityKey(
    "session-fingerprint",
    "AFFILIATE_SESSION_FINGERPRINT_SECRET"
  );
}

function getStrictUserAgentMode() {
  const configured = String(
    process.env.AFFILIATE_SESSION_STRICT_USER_AGENT || ""
  )
    .trim()
    .toLowerCase();

  if (configured) {
    return ["1", "true", "yes", "on"].includes(configured);
  }

  return env.nodeEnv === "production";
}

function deriveCsrfToken(tokenHash) {
  return crypto
    .createHmac("sha256", getCsrfKey())
    .update(`affiliate-csrf-v2:${tokenHash}`, "utf8")
    .digest("base64url");
}

function hashAttribute(value) {
  const normalized = String(value || "").trim();
  if (!normalized) return null;

  return crypto
    .createHmac("sha256", getFingerprintKey())
    .update(normalized, "utf8")
    .digest("hex");
}

function getFingerprint(req) {
  return {
    ip_hash: hashAttribute(req.ip || req.socket?.remoteAddress || ""),
    user_agent_hash: hashAttribute(
      req.get?.("user-agent") || req.headers?.["user-agent"] || ""
    ),
  };
}

function sessionError(message, statusCode = 401, code = "AFFILIATE_SESSION_INVALID") {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function getTimes(now = Date.now()) {
  const absoluteExpires = now + ABSOLUTE_TTL_MS;
  return {
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(absoluteExpires).toISOString(),
    idleExpiresAt: new Date(Math.min(absoluteExpires, now + IDLE_TTL_MS)).toISOString(),
  };
}

export async function createAffiliateSession({ req, affiliate }) {
  if (!affiliate?.id) {
    throw sessionError(
      "Afiliado inválido para criação de sessão.",
      500,
      "AFFILIATE_SESSION_AFFILIATE_MISSING"
    );
  }

  const token = crypto.randomBytes(SESSION_TOKEN_BYTES).toString("base64url");
  const tokenHash = hashToken(token);
  const csrfToken = deriveCsrfToken(tokenHash);
  const csrfTokenHash = hashToken(csrfToken);
  const times = getTimes();
  const fingerprint = getFingerprint(req);

  const { data, error } = await supabaseAdmin.rpc("create_affiliate_single_session", {
    p_affiliate_id: affiliate.id,
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
    console.error("[AFFILIATE_SESSION_CREATE_ERROR]", {
      affiliate_id: affiliate.id,
      message: error?.message || "Sessão não retornada pelo banco.",
    });
    throw sessionError(
      "Não foi possível iniciar uma sessão segura.",
      503,
      "AFFILIATE_SESSION_CREATE_FAILED"
    );
  }

  return {
    token,
    csrfToken,
    session: row,
    revokedSessions: Number(row.revoked_sessions || 0),
  };
}

export async function revokeAffiliateSessionById(sessionId, reason = "revoked") {
  if (!sessionId) return;

  await supabaseAdmin
    .from("affiliate_sessions")
    .update({
      revoked_at: new Date().toISOString(),
      revoke_reason: String(reason || "revoked").slice(0, 120),
    })
    .eq("id", sessionId)
    .is("revoked_at", null);
}

export async function validateAffiliateSessionToken(token, { req } = {}) {
  const normalizedToken = String(token || "").trim();
  if (normalizedToken.length < 40 || normalizedToken.length > 256) {
    throw sessionError("Sessão do afiliado inválida.");
  }

  const tokenHash = hashToken(normalizedToken);
  if (!TOKEN_HASH_PATTERN.test(tokenHash)) {
    throw sessionError("Sessão do afiliado inválida.");
  }

  const { data, error } = await supabaseAdmin
    .from("affiliate_sessions")
    .select(
      "id,affiliate_id,session_version,token_hash,csrf_token_hash,created_at,last_seen_at,expires_at,idle_expires_at,revoked_at,revoke_reason,ip_hash,user_agent_hash"
    )
    .eq("token_hash", tokenHash)
    .maybeSingle();

  if (error) {
    console.error("[AFFILIATE_SESSION_LOOKUP_ERROR]", { message: error.message });
    throw sessionError(
      "Não foi possível validar a sessão do afiliado.",
      503,
      "AFFILIATE_SESSION_LOOKUP_FAILED"
    );
  }

  if (!data) {
    throw sessionError("Sessão do afiliado inválida ou encerrada.");
  }

  if (data.revoked_at) {
    if (String(data.revoke_reason || "") === "concurrent_session_limit") {
      throw sessionError(
        "Um novo login foi realizado nesta conta. Esta sessão foi encerrada.",
        401,
        "AFFILIATE_SESSION_REPLACED"
      );
    }
    throw sessionError("Sessão do afiliado revogada.", 401, "AFFILIATE_SESSION_REVOKED");
  }

  const now = Date.now();
  const absoluteExpires = Date.parse(data.expires_at);
  const idleExpires = Date.parse(data.idle_expires_at);

  if (
    !Number.isFinite(absoluteExpires) ||
    !Number.isFinite(idleExpires) ||
    now >= absoluteExpires ||
    now >= idleExpires
  ) {
    await revokeAffiliateSessionById(data.id, "expired");
    throw sessionError("Sessão do afiliado expirada.", 401, "AFFILIATE_SESSION_EXPIRED");
  }

  if (req) {
    const fingerprint = getFingerprint(req);
    const userAgentChanged = Boolean(
      data.user_agent_hash &&
        fingerprint.user_agent_hash &&
        data.user_agent_hash !== fingerprint.user_agent_hash
    );
    const ipChanged = Boolean(
      data.ip_hash && fingerprint.ip_hash && data.ip_hash !== fingerprint.ip_hash
    );

    if (userAgentChanged || ipChanged) {
      console.warn("[AFFILIATE_SESSION_FINGERPRINT_CHANGED]", {
        session_id: data.id,
        affiliate_id: data.affiliate_id,
        user_agent_changed: userAgentChanged,
        ip_changed: ipChanged,
      });
    }

    // IP de celular/CGNAT muda com frequência e serve apenas como telemetria.
    // User-Agent, por outro lado, é estável o bastante para bloquear reutilização
    // de cookie roubado em outro navegador/dispositivo.
    if (userAgentChanged && getStrictUserAgentMode()) {
      await revokeAffiliateSessionById(data.id, "user_agent_changed");
      throw sessionError(
        "Sessão do afiliado alterada de navegador.",
        401,
        "AFFILIATE_SESSION_USER_AGENT_CHANGED"
      );
    }

    const lastSeen = Date.parse(data.last_seen_at);
    if (!Number.isFinite(lastSeen) || now - lastSeen >= TOUCH_INTERVAL_MS) {
      const nextIdle = Math.min(absoluteExpires, now + IDLE_TTL_MS);
      const { error: touchError } = await supabaseAdmin
        .from("affiliate_sessions")
        .update({
          last_seen_at: new Date(now).toISOString(),
          idle_expires_at: new Date(nextIdle).toISOString(),
        })
        .eq("id", data.id)
        .is("revoked_at", null);

      if (!touchError) {
        data.last_seen_at = new Date(now).toISOString();
        data.idle_expires_at = new Date(nextIdle).toISOString();
      }
    }
  }

  return {
    ...data,
    csrfToken: deriveCsrfToken(data.token_hash),
  };
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

export function assertAffiliateCsrfProtection(req, session) {
  const method = String(req.method || "GET").toUpperCase();
  if (SAFE_METHODS.has(method)) return;

  const origin = getRequestOrigin(req);
  if (!origin || !getAllowedOrigins().has(origin)) {
    throw sessionError(
      "Origem da requisição do afiliado não autorizada.",
      403,
      "AFFILIATE_CSRF_ORIGIN_REJECTED"
    );
  }

  const supplied = String(
    req.get?.("x-csrf-token") || req.headers?.["x-csrf-token"] || ""
  ).trim();

  if (!supplied || supplied.length > 256 || !session?.csrf_token_hash) {
    throw sessionError(
      "Proteção CSRF ausente ou inválida.",
      403,
      "AFFILIATE_CSRF_TOKEN_MISSING"
    );
  }

  const suppliedHash = hashToken(supplied);
  const expected = String(session.csrf_token_hash || "");

  if (
    suppliedHash.length !== expected.length ||
    !crypto.timingSafeEqual(
      Buffer.from(suppliedHash, "utf8"),
      Buffer.from(expected, "utf8")
    )
  ) {
    throw sessionError(
      "Proteção CSRF inválida.",
      403,
      "AFFILIATE_CSRF_TOKEN_INVALID"
    );
  }
}

export async function revokeAffiliateSessionToken(token, reason = "logout") {
  const normalized = String(token || "").trim();
  if (!normalized) return false;

  const { data, error } = await supabaseAdmin
    .from("affiliate_sessions")
    .update({
      revoked_at: new Date().toISOString(),
      revoke_reason: String(reason || "logout").slice(0, 120),
    })
    .eq("token_hash", hashToken(normalized))
    .is("revoked_at", null)
    .select("id")
    .maybeSingle();

  if (error) {
    throw sessionError(
      "Não foi possível encerrar a sessão.",
      503,
      "AFFILIATE_SESSION_LOGOUT_FAILED"
    );
  }

  return Boolean(data?.id);
}
