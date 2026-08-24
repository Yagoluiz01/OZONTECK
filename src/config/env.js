import dotenv from "dotenv";

dotenv.config();

const requiredEnv = [
  "PORT",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_ANON_KEY",
  "JWT_SECRET",
  "FRONTEND_URL",
];

for (const key of requiredEnv) {
  if (!process.env[key]) {
    throw new Error(`Variável de ambiente obrigatória ausente: ${key}`);
  }
}


function isTruthyEnv(value) {
  return ["1", "true", "yes", "on"].includes(
    String(value || "").trim().toLowerCase()
  );
}

const nodeEnv = process.env.NODE_ENV || "development";

if (nodeEnv === "production" && isTruthyEnv(process.env.ENABLE_PAYMENT_SIMULATION)) {
  throw new Error(
    "ENABLE_PAYMENT_SIMULATION não pode permanecer ativo em produção. Defina false antes de iniciar a API."
  );
}

export const env = {
  nodeEnv,
  port: Number(process.env.PORT) || 5000,
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY,
  jwtSecret: process.env.JWT_SECRET,
  frontendUrl: process.env.FRONTEND_URL,
  deepseekApiKey: process.env.DEEPSEEK_API_KEY || "",
  apiBaseUrl: process.env.API_BASE_URL || "",

  // Nomes preferidos: MERCADO_PAGO_*. Os aliases MERCADOPAGO_*
  // permanecem aceitos para compatibilidade com configurações antigas do Render.
  mercadoPagoAccessToken:
    process.env.MERCADO_PAGO_ACCESS_TOKEN ||
    process.env.MERCADOPAGO_ACCESS_TOKEN ||
    "",
  mercadoPagoPublicKey:
    process.env.MERCADO_PAGO_PUBLIC_KEY ||
    process.env.MERCADOPAGO_PUBLIC_KEY ||
    "",
  mercadoPagoWebhookSecret:
    process.env.MERCADO_PAGO_WEBHOOK_SECRET ||
    process.env.MERCADOPAGO_WEBHOOK_SECRET ||
    "",
  mercadoPagoAllowUnsignedWebhooks:
    process.env.MERCADO_PAGO_ALLOW_UNSIGNED_WEBHOOKS || "false",
  mercadoPagoWebhookMaxSkewSeconds: Number(
    process.env.MERCADO_PAGO_WEBHOOK_MAX_SKEW_SECONDS || 600
  ),
  mercadoPagoReconcileEnabled:
    process.env.MERCADO_PAGO_RECONCILE_ENABLED || "true",
  mercadoPagoReconcileIntervalSeconds: Number(
    process.env.MERCADO_PAGO_RECONCILE_INTERVAL_SECONDS || 120
  ),
  mercadoPagoReconcileBatchLimit: Number(
    process.env.MERCADO_PAGO_RECONCILE_BATCH_LIMIT || 30
  ),

  storeSuccessUrl: process.env.STORE_SUCCESS_URL || "",
  storePendingUrl: process.env.STORE_PENDING_URL || "",
  storeFailureUrl: process.env.STORE_FAILURE_URL || "",

  enablePaymentSimulation: process.env.ENABLE_PAYMENT_SIMULATION || "",

  frenetToken: process.env.FRENET_TOKEN || "",
  frenetOriginZipCode: process.env.FRENET_ORIGIN_ZIP_CODE || "",
  frenetQuoteUrl: process.env.FRENET_QUOTE_URL || "https://api.frenet.com.br/shipping/quote",

   frenetLabelUrl: process.env.FRENET_LABEL_URL || "",
  frenetSandbox: process.env.FRENET_SANDBOX || "",

  smtpHost: process.env.SMTP_HOST || "",
  smtpPort: Number(process.env.SMTP_PORT) || 587,
  smtpUser: process.env.SMTP_USER || "",
  smtpPass: process.env.SMTP_PASS || "",
  smtpFromName: process.env.SMTP_FROM_NAME || "OZONTECK",
  smtpFromEmail: process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER || "",
  notificationsEnabled: process.env.NOTIFICATIONS_ENABLED || "false",
  stockNotificationsEnabled: process.env.STOCK_NOTIFICATIONS_ENABLED || "true",
  stockLowAlertThreshold: Number(process.env.STOCK_LOW_ALERT_THRESHOLD || 5),

  // Marketing personalizado é independente das notificações operacionais.
  // Os padrões impedem envio real até migration, dry-run e consentimento serem validados.
  productInterestNotificationsEnabled:
    process.env.PRODUCT_INTEREST_NOTIFICATIONS_ENABLED || "false",
  productInterestNotificationsDryRun:
    process.env.PRODUCT_INTEREST_NOTIFICATIONS_DRY_RUN || "true",
  productInterestConsentConfirmed:
    process.env.PRODUCT_INTEREST_CONSENT_CONFIRMED || "false",
  productInterestEmailEnabled:
    process.env.PRODUCT_INTEREST_EMAIL_ENABLED || "true",
  productInterestWebPushEnabled:
    process.env.PRODUCT_INTEREST_WEB_PUSH_ENABLED || "true",
  productInterestWorkerIntervalSeconds: Number(
    process.env.PRODUCT_INTEREST_WORKER_INTERVAL_SECONDS || 60
  ),
};
