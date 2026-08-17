import { isAuthorizedLoadTestRequest } from "./loadTestBypass.middleware.js";
import rateLimit from "express-rate-limit";

const PUBLIC_CACHED_GET_PATHS = new Set([
  "/api/store/theme",
  "/api/store/products",
  "/api/store/products/home",
  "/api/store/categories/active",
  "/api/store/marketing/pixels",
  "/api/banners/active",
  "/api/store/health",
]);

function toPositiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

export function isPublicCachedReadRequest(req = {}) {
  if (String(req.method || "").toUpperCase() !== "GET") return false;

  const path = String(
    req.path || String(req.originalUrl || "").split("?")[0] || "",
  );

  return (
    PUBLIC_CACHED_GET_PATHS.has(path) ||
    path.startsWith("/api/store/products/")
  );
}

// Leituras públicas já servidas por cache recebem uma faixa própria. Isso
// evita que uma campanha com muitos acessos bloqueie produtos, tema e banners,
// sem afrouxar os limites de login, frete, checkout, pedido ou pagamento.
export const publicStoreReadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: toPositiveNumber(
    process.env.PUBLIC_STORE_READ_RATE_LIMIT_MAX,
    6_000,
  ),
  standardHeaders: true,
  legacyHeaders: false,
  skip(req) {
    return req.method === "OPTIONS" || isAuthorizedLoadTestRequest(req);
  },
  message: {
    success: false,
    message: "Muitas leituras públicas. Aguarde alguns instantes e tente novamente.",
  },
});
