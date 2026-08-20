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
  skipSuccessfulRequests = false,
}) {
  return rateLimit({
    windowMs,
    max: toPositiveNumber(process.env[envMaxKey], max),
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests,
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
  max: 8,
  envMaxKey: "ADMIN_AUTH_RATE_LIMIT_MAX",
  skipSuccessfulRequests: true,
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

export const affiliateLoginLimiter = createSecurityLimiter({
  windowMs: 15 * 60 * 1000,
  // Este limiter é por IP. O guard persistente por conta continua em 8 falhas;
  // uma margem maior aqui evita bloquear toda uma rede compartilhada/CGNAT.
  max: 20,
  envMaxKey: "AFFILIATE_LOGIN_RATE_LIMIT_MAX",
  skipSuccessfulRequests: true,
  message: "Muitas tentativas de acesso do afiliado. Aguarde alguns minutos e tente novamente.",
});

export const affiliateEmailStatusLimiter = createSecurityLimiter({
  windowMs: 15 * 60 * 1000,
  max: 30,
  envMaxKey: "AFFILIATE_EMAIL_STATUS_RATE_LIMIT_MAX",
  message: "Muitas consultas de cadastro. Aguarde alguns minutos e tente novamente.",
});

export const affiliateApplicationLimiter = createSecurityLimiter({
  windowMs: 60 * 60 * 1000,
  max: 10,
  envMaxKey: "AFFILIATE_APPLICATION_RATE_LIMIT_MAX",
  message: "Muitas solicitações de cadastro. Aguarde e tente novamente mais tarde.",
});

export const affiliatePasswordRecoveryLimiter = createSecurityLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  envMaxKey: "AFFILIATE_PASSWORD_RECOVERY_RATE_LIMIT_MAX",
  message: "Muitas solicitações de recuperação. Aguarde alguns minutos e tente novamente.",
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


export const storePaymentLimiter = createSecurityLimiter({
  windowMs: 15 * 60 * 1000,
  max: 30,
  envMaxKey: "STORE_PAYMENT_RATE_LIMIT_MAX",
  message: "Muitas tentativas de pagamento. Aguarde alguns minutos e tente novamente.",
});

export const storeInstallmentsLimiter = createSecurityLimiter({
  windowMs: 5 * 60 * 1000,
  max: 120,
  envMaxKey: "STORE_INSTALLMENTS_RATE_LIMIT_MAX",
  message: "Muitas consultas de parcelamento. Aguarde alguns instantes e tente novamente.",
});


export const storeOrderAccessLimiter = createSecurityLimiter({
  windowMs: 5 * 60 * 1000,
  max: 180,
  envMaxKey: "STORE_ORDER_ACCESS_RATE_LIMIT_MAX",
  message: "Muitas consultas ao pedido. Aguarde alguns instantes e tente novamente.",
});

export const storePaymentWebhookLimiter = createSecurityLimiter({
  windowMs: 60 * 1000,
  max: 240,
  envMaxKey: "STORE_PAYMENT_WEBHOOK_RATE_LIMIT_MAX",
  message: "Muitas notificações de pagamento.",
});
