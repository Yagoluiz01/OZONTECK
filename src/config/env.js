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

export const env = {
  port: Number(process.env.PORT) || 5000,
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY,
  jwtSecret: process.env.JWT_SECRET,
  frontendUrl: process.env.FRONTEND_URL,

  apiBaseUrl: process.env.API_BASE_URL || "",

  mercadoPagoAccessToken: process.env.MERCADO_PAGO_ACCESS_TOKEN || "",
  mercadoPagoWebhookSecret: process.env.MERCADO_PAGO_WEBHOOK_SECRET || "",

  storeSuccessUrl: process.env.STORE_SUCCESS_URL || "",
  storePendingUrl: process.env.STORE_PENDING_URL || "",
  storeFailureUrl: process.env.STORE_FAILURE_URL || "",

  enablePaymentSimulation: process.env.ENABLE_PAYMENT_SIMULATION || "",

  frenetToken: process.env.FRENET_TOKEN || "",
  frenetOriginZipCode: process.env.FRENET_ORIGIN_ZIP_CODE || "",
  frenetQuoteUrl: process.env.FRENET_QUOTE_URL || "https://api.frenet.com.br/shipping/quote",

  frenetLabelUrl: process.env.FRENET_LABEL_URL || "",
  frenetSandbox: process.env.FRENET_SANDBOX || ""
};