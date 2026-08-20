import jwt from "jsonwebtoken";

import { env } from "../config/env.js";

const LEGACY_BRIDGE_MAX_WINDOW_MS = 48 * 60 * 60 * 1000;
const LEGACY_TOKEN_TTL_SECONDS = 60 * 60;

function isTruthy(value) {
  return ["1", "true", "yes", "on"].includes(
    String(value || "").trim().toLowerCase()
  );
}

function getJwtSecret() {
  const secret = String(env.jwtSecret || process.env.JWT_SECRET || "").trim();
  if (!secret) {
    const error = new Error("JWT_SECRET ausente para a ponte legada de afiliados.");
    error.code = "AFFILIATE_LEGACY_BRIDGE_SECRET_MISSING";
    throw error;
  }
  return secret;
}

function getBridgeDeadlineMs() {
  const raw = String(process.env.AFFILIATE_LEGACY_AUTH_BRIDGE_UNTIL || "").trim();
  const parsed = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(parsed) ? parsed : NaN;
}

export function isAffiliateLegacyBridgeConfigured() {
  return isTruthy(process.env.AFFILIATE_LEGACY_AUTH_BRIDGE);
}

export function isAffiliateLegacyBridgeEnabled() {
  if (!isAffiliateLegacyBridgeConfigured()) return false;
  const deadline = getBridgeDeadlineMs();
  return Number.isFinite(deadline) && Date.now() < deadline;
}

export function assertAffiliateLegacyBridgeConfiguration() {
  if (!isAffiliateLegacyBridgeConfigured()) return true;

  const deadline = getBridgeDeadlineMs();
  const now = Date.now();
  if (!Number.isFinite(deadline) || deadline <= now) {
    const error = new Error(
      "Ponte legada de afiliados solicitada sem AFFILIATE_LEGACY_AUTH_BRIDGE_UNTIL futuro."
    );
    error.code = "AFFILIATE_LEGACY_BRIDGE_DEADLINE_INVALID";
    throw error;
  }

  if (deadline - now > LEGACY_BRIDGE_MAX_WINDOW_MS) {
    const error = new Error(
      "AFFILIATE_LEGACY_AUTH_BRIDGE_UNTIL não pode ultrapassar 48 horas."
    );
    error.code = "AFFILIATE_LEGACY_BRIDGE_WINDOW_TOO_LONG";
    throw error;
  }

  getJwtSecret();
  console.warn("[AFFILIATE_LEGACY_AUTH_BRIDGE_ENABLED]", {
    until: new Date(deadline).toISOString(),
  });
  return true;
}

export function signAffiliateLegacyBridgeToken(affiliate) {
  if (!isAffiliateLegacyBridgeEnabled()) return null;
  if (!affiliate?.id) return null;

  const deadline = getBridgeDeadlineMs();
  const secondsUntilDeadline = Math.max(1, Math.floor((deadline - Date.now()) / 1000));
  const expiresIn = Math.min(LEGACY_TOKEN_TTL_SECONDS, secondsUntilDeadline);

  return jwt.sign(
    {
      type: "affiliate",
      affiliate_id: affiliate.id,
      email: affiliate.email || null,
      auth_version: Number(affiliate.auth_token_version || affiliate.authVersion || 1),
      bridge: true,
    },
    getJwtSecret(),
    {
      algorithm: "HS256",
      expiresIn,
    }
  );
}

export function verifyAffiliateLegacyBridgeToken(token) {
  if (!isAffiliateLegacyBridgeEnabled()) {
    const error = new Error("Ponte legada de afiliados desativada.");
    error.code = "AFFILIATE_LEGACY_BRIDGE_DISABLED";
    throw error;
  }

  const decoded = jwt.verify(String(token || ""), getJwtSecret(), {
    algorithms: ["HS256"],
  });

  // Aceita durante a janela tanto tokens antigos já emitidos quanto tokens
  // de transição. Ambos precisam ter a estrutura histórica estrita.
  if (
    !decoded ||
    decoded.type !== "affiliate" ||
    !decoded.affiliate_id ||
    !Number.isFinite(Number(decoded.auth_version || 0))
  ) {
    const error = new Error("Token legado de afiliado inválido.");
    error.code = "AFFILIATE_LEGACY_BRIDGE_TOKEN_INVALID";
    throw error;
  }

  return decoded;
}
