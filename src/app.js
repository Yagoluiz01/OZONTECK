import aiRoutes from "./routes/ai.routes.js";
import reportRoutes from "./routes/report.routes.js";
import adminAiRoutes from "./routes/adminAi.routes.js";
import adminMarketingPixelsRoutes from "./routes/adminMarketingPixels.routes.js";
import adminAffiliateMarketingRoutes from "./routes/adminAffiliateMarketing.routes.js";
import affiliateMarketingRoutes from './routes/affiliateMarketing.routes.js';
import express from "express";
import crypto from "crypto";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import path from "path";
import { fileURLToPath } from "url";
import rateLimit from "express-rate-limit";
import {
  adminAccessRequestLimiter,
  adminAuthLimiter,
  adminPasswordRecoveryLimiter,
  affiliateAuthLimiter,
  storeCheckoutLimiter,
  storeCustomerAuthLimiter,
  storeQuoteLimiter,
} from "./middlewares/rate-limit.middleware.js";
import adminNotificationsRoutes from "./routes/adminNotifications.routes.js";
import adminAuditRoutes from "./routes/adminAudit.routes.js";
import adminAccessRequestsRoutes from "./routes/adminAccessRequests.routes.js";
import adminPermissionsRoutes from "./routes/adminPermissions.routes.js";
import adminPushRoutes from "./routes/adminPush.routes.js";
import adminStoreThemeRoutes from "./routes/adminStoreTheme.routes.js";
import storeThemeRoutes from "./routes/storeTheme.routes.js";

import { env } from "./config/env.js";
import authRoutes from "./routes/auth.routes.js";
import productsRoutes from "./routes/products.routes.js";
import categoriesRoutes from "./routes/categories.routes.js";
import ordersRoutes from "./routes/orders.routes.js";
import customersRoutes from "./routes/customers.routes.js";
import settingsRoutes from "./routes/settings.routes.js";
import trackingRoutes from "./routes/tracking.routes.js";
import storeRoutes from "./routes/store.routes.js";
import storeCustomerAccountRoutes from "./routes/storeCustomerAccount.routes.js";
import shippingRoutes from "./routes/shipping.routes.js";
import adminFinancialRoutes from "./routes/adminFinancial.routes.js";
import adminPricingRoutes from "./routes/adminPricing.routes.js";
import adminFiscalRoutes from "./routes/adminFiscal.routes.js";
import adminAffiliatesRoutes from "./routes/adminAffiliates.routes.js";
import affiliatePortalRoutes from "./routes/affiliatePortal.routes.js";
import affiliateFeedRoutes from "./routes/affiliateFeed.routes.js";
import adminAffiliateFeedRoutes from "./routes/adminAffiliateFeed.routes.js";
import affiliatePasswordRoutes from "./routes/affiliatePassword.routes.js";
import { updateStorefrontProfilePhoto } from "./controllers/affiliatePortal.controller.js";
import { requireAffiliateAuth } from "./middlewares/affiliateAuth.middleware.js";
import melhorEnvioWebhookRoutes from "./routes/melhorEnvioWebhook.routes.js";
import { captureAdminMutationAudit } from "./middlewares/audit.middleware.js";

const app = express();

// A API roda atrás do proxy reverso do Render.
// Confiar em exatamente um salto permite que req.ip e o express-rate-limit
// identifiquem cada cliente pelo IP real, em vez de agrupar todos no IP do proxy.
app.set("trust proxy", 1);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function normalizeOrigin(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function getExtraAllowedOrigins() {
  const raw =
    process.env.CORS_ORIGINS ||
    process.env.ALLOWED_ORIGINS ||
    process.env.FRONTEND_URLS ||
    "";

  return String(raw || "")
    .split(",")
    .map(normalizeOrigin)
    .filter(Boolean);
}

const allowedOrigins = [
  env.frontendUrl,

  process.env.FRONTEND_URL,
  process.env.ADMIN_FRONTEND_URL,
  process.env.STORE_FRONTEND_URL,

  "https://ozonteck-loja.onrender.com",
  "https://ozonteck-admin.onrender.com",
  "https://ozonteck-api-staging.onrender.com",

  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://192.168.1.34:5173",

  "http://localhost:5174",
  "http://127.0.0.1:5174",
  "http://192.168.1.34:5174",

  "http://localhost:5500",
  "http://127.0.0.1:5500",

  ...getExtraAllowedOrigins(),
]
  .map(normalizeOrigin)
  .filter(Boolean);

function isTruthyEnv(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

const strictCors = isTruthyEnv(process.env.STRICT_CORS);
const allowLocalCorsInProduction = isTruthyEnv(
  process.env.ALLOW_LOCAL_CORS_IN_PRODUCTION
);

function isAllowedCorsOrigin(origin) {
  const normalizedOrigin = normalizeOrigin(origin);

  // Requisições servidor-servidor e webhooks normalmente não enviam Origin.
  // CORS não é mecanismo de autenticação, então elas devem continuar funcionando.
  if (!normalizedOrigin) {
    return true;
  }

  const isLocalDevelopmentOrigin =
    normalizedOrigin.startsWith("http://localhost:") ||
    normalizedOrigin.startsWith("http://127.0.0.1:") ||
    normalizedOrigin.startsWith("http://192.168.");

  if (isLocalDevelopmentOrigin) {
    if (env.nodeEnv === "production") {
      return allowLocalCorsInProduction && !strictCors;
    }

    return true;
  }

  return allowedOrigins.includes(normalizedOrigin);
}

const corsMiddleware = cors({
  origin(origin, callback) {
    if (isAllowedCorsOrigin(origin)) {
      return callback(null, true);
    }

    const corsError = new Error(`Origem não permitida por CORS: ${origin}`);
    corsError.statusCode = 403;
    return callback(corsError);
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "Accept",
    "Origin",
    "X-Requested-With",
    "X-Signature",
    "X-Request-Id",
    "X-Order-Access-Token",
    "X-ME-Attempt",
    "X-ME-Topic",
    "X-ME-Event-ID",
    "X-ME-WEBHOOK-SIGNATURE",
    "X-ME-Signature",
  ],
  optionsSuccessStatus: 204,
});

/**
 * IMPORTANTE:
 * CORS precisa vir ANTES do rate limit.
 * Se o rate limit bloquear o preflight OPTIONS, o navegador mostra como erro de CORS.
 */
app.use(corsMiddleware);

const adminAiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.ADMIN_AI_RATE_LIMIT_MAX || 40),
  standardHeaders: true,
  legacyHeaders: false,
  skip(req) {
    return req.method === "OPTIONS";
  },
  message: {
    success: false,
    message: "Muitas requisições para o assistente. Tente novamente em instantes.",
  },
});

const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_MAX || 1000),
  standardHeaders: true,
  legacyHeaders: false,
  skip(req) {
    return req.method === "OPTIONS";
  },
  message: {
    success: false,
    message: "Muitas requisições. Tente novamente em alguns minutos.",
  },
});

app.use(globalLimiter);

// Limites específicos para pontos sensíveis.
// Ficam antes das rotas e não alteram nenhuma regra de negócio validada.
app.post("/api/auth/login", adminAuthLimiter);
app.post("/api/auth/forgot-password", adminPasswordRecoveryLimiter);
app.post("/api/auth/reset-password", adminPasswordRecoveryLimiter);
app.post("/api/auth/admin-register-request", adminAccessRequestLimiter);
app.post("/api/affiliate/auth/login", affiliateAuthLimiter);
app.post("/api/affiliate/auth/forgot-password", affiliateAuthLimiter);
app.post("/api/public/affiliates/password/forgot-password", affiliateAuthLimiter);
app.post("/api/public/affiliates/password/reset-password", affiliateAuthLimiter);
app.post("/api/store/customer/login", storeCustomerAuthLimiter);
app.post("/api/store/customer/register", storeCustomerAuthLimiter);
app.post("/api/store/shipping/quote", storeQuoteLimiter);
app.post("/api/store/orders", storeCheckoutLimiter);


app.use((req, res, next) => {
  if (req.path.startsWith("/api/auth") || req.path.startsWith("/api/admin")) {
    res.setHeader("Cache-Control", "no-store");
  }
  return next();
});

app.use(
  helmet({
    crossOriginResourcePolicy: false,
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "blob:", "https:"],
        connectSrc: ["'self'", "https:", "wss:"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
      },
    },
    frameguard: { action: "deny" },
    noSniff: true,
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
  })
);

app.use(morgan("dev"));

// O webhook precisa do corpo bruto para validar a assinatura HMAC.
// O parser fica isolado para não elevar o limite de todas as demais rotas.
app.use(
  "/api/integrations/melhor-envio/webhook",
  express.json({
    limit: "2mb",
    verify(req, res, buf) {
      req.rawBody = Buffer.from(buf);
    },
  })
);

// O upload legado do kit ainda usa base64 dentro de JSON. O limite maior fica
// restrito somente a esse módulo; o próprio roteador valida 50 MB reais.
app.use(
  "/api/admin/affiliate-marketing",
  express.json({ limit: "70mb" })
);

// Demais endpoints não precisam aceitar corpos gigantes em memória.
app.use(express.json({ limit: "2mb" }));

// Registra automaticamente alterações administrativas após a resposta terminar.
// A falha da auditoria nunca bloqueia a operação principal.
app.use(captureAdminMutationAudit);

app.use("/labels", express.static(path.join(__dirname, "public/labels")));

app.get("/api/health", (req, res) => {
  return res.status(200).json({
    success: true,
    message: "API OZONTECK funcionando",
  });
});

app.use("/api/tracking", trackingRoutes);
app.use("/api/store", storeThemeRoutes);
app.use("/api/store/customer", storeCustomerAccountRoutes);
app.use("/api/store", storeRoutes);
app.use("/api/integrations/melhor-envio", melhorEnvioWebhookRoutes);


app.use("/api/admin/store-theme", adminStoreThemeRoutes);
app.use("/api/admin/marketing-pixels", adminMarketingPixelsRoutes);
app.use("/api/admin/affiliate-marketing", adminAffiliateMarketingRoutes);
app.use("/api/admin/affiliate-feed", adminAffiliateFeedRoutes);
app.use('/api/affiliate/marketing-kit', affiliateMarketingRoutes);
app.use("/api/admin/financial", adminFinancialRoutes);
app.use("/api/admin/pricing", adminPricingRoutes);
app.use("/api/admin/fiscal", adminFiscalRoutes);
app.use("/api/admin/affiliates", adminAffiliatesRoutes);
app.use("/api/admin/notifications", adminNotificationsRoutes);
app.use("/api/admin/audit", adminAuditRoutes);
app.use("/api/auth", authRoutes);
app.use("/api", adminAccessRequestsRoutes);
app.use("/api", adminPermissionsRoutes);
app.use("/api/admin/push", adminPushRoutes);
app.use("/api/products", productsRoutes);
app.use("/api/reports", reportRoutes);
app.use("/api/categories", categoriesRoutes);
app.use("/api/orders", ordersRoutes);
app.use("/api/customers", customersRoutes);
app.use("/api/settings", settingsRoutes);
app.use("/api/shipping", shippingRoutes);
app.use("/api/affiliate/feed", affiliateFeedRoutes);
app.use("/api/affiliate", affiliatePortalRoutes);
app.use("/api/admin/ai", adminAiLimiter, adminAiRoutes);
app.use("/api/admin/reports", reportRoutes);
app.use("/api/ai", aiRoutes);

// Alias direto de segurança para a foto da loja do afiliado.
// Mantém a rota funcionando mesmo se o roteador do portal não for recarregado em ambiente local.
app.patch("/api/affiliate/storefront/profile-photo", requireAffiliateAuth, updateStorefrontProfilePhoto);
app.post("/api/affiliate/storefront/profile-photo", requireAffiliateAuth, updateStorefrontProfilePhoto);

app.use('/api/public/affiliates/password', affiliatePasswordRoutes);

app.use((req, res) => {
  return res.status(404).json({
    success: false,
    message: "Rota não encontrada",
  });
});

app.use((err, req, res, next) => {
  const isMulterError = err?.name === "MulterError";
  const statusCode = Number(
    err.statusCode ||
      err.status ||
      (isMulterError && err.code === "LIMIT_FILE_SIZE" ? 413 : 0) ||
      (isMulterError ? 400 : 500)
  );
  const isProduction = env.nodeEnv === "production";
  const errorId = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;

  console.error("[APP_ERROR]", {
    errorId,
    statusCode,
    method: req.method,
    path: req.originalUrl,
    message: err?.message || "Erro interno no servidor.",
    name: err?.name,
    stack: isProduction ? undefined : err?.stack,
  });

  return res.status(statusCode).json({
    success: false,
    message:
      statusCode < 500
        ? err.message || "Requisição inválida."
        : isProduction
          ? "Erro interno no servidor."
          : err.message || "Erro interno no servidor.",
    errorId,
  });
});

export default app;