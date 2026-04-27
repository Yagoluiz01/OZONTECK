import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import path from "path";
import { fileURLToPath } from "url";
import rateLimit from "express-rate-limit";

import { env } from "./config/env.js";
import authRoutes from "./routes/auth.routes.js";
import productsRoutes from "./routes/products.routes.js";
import categoriesRoutes from "./routes/categories.routes.js";
import ordersRoutes from "./routes/orders.routes.js";
import customersRoutes from "./routes/customers.routes.js";
import settingsRoutes from "./routes/settings.routes.js";
import trackingRoutes from "./routes/tracking.routes.js";
import storeRoutes from "./routes/store.routes.js";
import shippingRoutes from "./routes/shipping.routes.js";
import adminFinancialRoutes from "./routes/adminFinancial.routes.js";
import adminPricingRoutes from "./routes/adminPricing.routes.js";
import adminAffiliatesRoutes from "./routes/adminAffiliates.routes.js";
import affiliatePortalRoutes from "./routes/affiliatePortal.routes.js";

const app = express();

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

function isAllowedCorsOrigin(origin) {
  const normalizedOrigin = normalizeOrigin(origin);

  if (!normalizedOrigin) {
    return env.nodeEnv !== "production";
  }

  if (allowedOrigins.includes(normalizedOrigin)) {
    return true;
  }

  if (
    normalizedOrigin.startsWith("http://localhost:") ||
    normalizedOrigin.startsWith("http://127.0.0.1:") ||
    normalizedOrigin.startsWith("http://192.168.")
  ) {
    return true;
  }

  return false;
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
  ],
  optionsSuccessStatus: 204,
});

/**
 * IMPORTANTE:
 * CORS precisa vir ANTES do rate limit.
 * Se o rate limit bloquear o preflight OPTIONS, o navegador mostra como erro de CORS.
 */
app.use(corsMiddleware);

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

app.use(
  helmet({
    crossOriginResourcePolicy: false,
  })
);

app.use(morgan("dev"));
app.use(express.json({ limit: "1mb" }));

app.use("/labels", express.static(path.join(__dirname, "../public/labels")));

app.get("/api/health", (req, res) => {
  return res.status(200).json({
    success: true,
    message: "API OZONTECK funcionando",
  });
});

app.use("/api/tracking", trackingRoutes);
app.use("/api/store", storeRoutes);

app.use("/api/admin/financial", adminFinancialRoutes);
app.use("/api/admin/pricing", adminPricingRoutes);
app.use("/api/admin/affiliates", adminAffiliatesRoutes);

app.use("/api/auth", authRoutes);
app.use("/api/products", productsRoutes);
app.use("/api/categories", categoriesRoutes);
app.use("/api/orders", ordersRoutes);
app.use("/api/customers", customersRoutes);
app.use("/api/settings", settingsRoutes);
app.use("/api/shipping", shippingRoutes);
app.use("/api/tracking", trackingRoutes);
app.use("/api/store", storeRoutes);
app.use("/api/affiliate", affiliatePortalRoutes);

app.use("/api/admin/financial", adminFinancialRoutes);

app.use((req, res) => {
  return res.status(404).json({
    success: false,
    message: "Rota não encontrada",
  });
});

app.use((err, req, res, next) => {
  const statusCode = err.statusCode || err.status || 500;
  const isProduction = env.nodeEnv === "production";

  console.error("[APP_ERROR]", err);

  return res.status(statusCode).json({
    success: false,
    message: isProduction
      ? "Erro interno no servidor."
      : err.message || "Erro interno no servidor.",
  });
});

export default app;