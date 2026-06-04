import rateLimit from "express-rate-limit";

function toPositiveNumber(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    return fallback;
  }
  return number;
}

function createSecurityLimiter({
  windowMs,
  max,
  envMaxKey,
  message,
}) {
  return rateLimit({
    windowMs,
    max: toPositiveNumber(process.env[envMaxKey], max),
    standardHeaders: true,
    legacyHeaders: false,
    skip(req) {
      return req.method === "OPTIONS";
    },
    message: {
      success: false,
      message,
    },
  });
}

// Login e troca de senha: limite mais rígido para reduzir tentativa de força bruta,
// mas ainda confortável para uso real do painel.
export const adminAuthLimiter = createSecurityLimiter({
  windowMs: 15 * 60 * 1000,
  max: 20,
  envMaxKey: "ADMIN_AUTH_RATE_LIMIT_MAX",
  message: "Muitas tentativas de acesso. Aguarde alguns minutos e tente novamente.",
});

export const adminPasswordRecoveryLimiter = createSecurityLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  envMaxKey: "ADMIN_PASSWORD_RECOVERY_RATE_LIMIT_MAX",
  message: "Muitas solicitações de recuperação. Aguarde alguns minutos e tente novamente.",
});

export const adminAccessRequestLimiter = createSecurityLimiter({
  windowMs: 60 * 60 * 1000,
  max: 10,
  envMaxKey: "ADMIN_ACCESS_REQUEST_RATE_LIMIT_MAX",
  message: "Muitas solicitações de acesso administrativo. Aguarde e tente novamente mais tarde.",
});

export const affiliateAuthLimiter = createSecurityLimiter({
  windowMs: 15 * 60 * 1000,
  max: 25,
  envMaxKey: "AFFILIATE_AUTH_RATE_LIMIT_MAX",
  message: "Muitas tentativas de acesso do afiliado. Aguarde alguns minutos e tente novamente.",
});

export const storeCustomerAuthLimiter = createSecurityLimiter({
  windowMs: 15 * 60 * 1000,
  max: 35,
  envMaxKey: "STORE_CUSTOMER_AUTH_RATE_LIMIT_MAX",
  message: "Muitas tentativas de acesso. Aguarde alguns minutos e tente novamente.",
});

// Cota e checkout precisam ser protegidos contra abuso, mas sem atrapalhar clientes reais.
export const storeQuoteLimiter = createSecurityLimiter({
  windowMs: 15 * 60 * 1000,
  max: 180,
  envMaxKey: "STORE_QUOTE_RATE_LIMIT_MAX",
  message: "Muitas cotações de frete. Aguarde alguns minutos e tente novamente.",
});

export const storeCheckoutLimiter = createSecurityLimiter({
  windowMs: 15 * 60 * 1000,
  max: 60,
  envMaxKey: "STORE_CHECKOUT_RATE_LIMIT_MAX",
  message: "Muitas tentativas de checkout. Aguarde alguns minutos e tente novamente.",
});
