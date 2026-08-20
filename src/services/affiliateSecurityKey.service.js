import crypto from "crypto";

import { env } from "../config/env.js";

const MIN_SECRET_BYTES = 32;
const ROOT_SECRET_NAMES = [
  "AFFILIATE_SECURITY_ROOT_SECRET",
  // Compatibilidade com o nome usado no primeiro rascunho da sessão segura.
  "AFFILIATE_SESSION_SECRET",
];

function byteLength(value) {
  return Buffer.byteLength(String(value || ""), "utf8");
}

function readFirstSecret(names = []) {
  for (const name of names) {
    const value = String(process.env[name] || "").trim();
    if (value) return { name, value };
  }
  return null;
}

function developmentFallback() {
  if (env.nodeEnv === "production") return null;

  const value = String(
    process.env.ADMIN_SESSION_FINGERPRINT_SECRET ||
      process.env.ADMIN_LOGIN_GUARD_SECRET ||
      env.jwtSecret ||
      ""
  ).trim();

  return value ? { name: "development-fallback", value } : null;
}

function validateSecret(secret, label) {
  if (!secret?.value || byteLength(secret.value) < MIN_SECRET_BYTES) {
    const error = new Error(
      `${label} deve ter pelo menos ${MIN_SECRET_BYTES} bytes de entropia/configuração.`
    );
    error.code = "AFFILIATE_SECURITY_SECRET_INVALID";
    throw error;
  }

  return secret.value;
}

function resolveBaseSecret(explicitEnvName) {
  const explicit = explicitEnvName
    ? readFirstSecret([explicitEnvName])
    : null;
  if (explicit) {
    return validateSecret(explicit, explicit.name);
  }

  const root = readFirstSecret(ROOT_SECRET_NAMES);
  if (root) {
    return validateSecret(root, root.name);
  }

  const fallback = developmentFallback();
  if (fallback) {
    return fallback.value;
  }

  const error = new Error(
    "Segredo de segurança do afiliado ausente. Configure AFFILIATE_SECURITY_ROOT_SECRET."
  );
  error.code = "AFFILIATE_SECURITY_SECRET_MISSING";
  throw error;
}

export function getAffiliateSecurityKey(purpose, explicitEnvName = null) {
  const normalizedPurpose = String(purpose || "generic").trim().toLowerCase();
  const baseSecret = resolveBaseSecret(explicitEnvName);

  // Separação de chaves por domínio: mesmo usando um root secret, CSRF,
  // fingerprint, rate-limit e telemetria nunca usam a mesma chave efetiva.
  return crypto
    .createHmac("sha256", baseSecret)
    .update(`ozonteck-affiliate-security:v2:${normalizedPurpose}`, "utf8")
    .digest();
}

export function assertAffiliateSecurityConfiguration() {
  if (env.nodeEnv !== "production") return true;

  const root = readFirstSecret(ROOT_SECRET_NAMES);
  if (root) {
    validateSecret(root, root.name);
    return true;
  }

  const requiredOverrides = [
    "AFFILIATE_CSRF_SECRET",
    "AFFILIATE_SESSION_FINGERPRINT_SECRET",
    "AFFILIATE_LOGIN_GUARD_SECRET",
    "AFFILIATE_INTRUSION_SECRET",
  ];

  for (const name of requiredOverrides) {
    const secret = readFirstSecret([name]);
    validateSecret(secret, name);
  }

  return true;
}
