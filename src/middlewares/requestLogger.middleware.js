import morgan from "morgan";
import { env } from "../config/env.js";
import { isPublicCachedReadRequest } from "./publicStoreReadLimiter.middleware.js";

export function shouldSkipRequestLog(req = {}, res = {}, nodeEnv = env.nodeEnv) {
  if (nodeEnv !== "production") return false;

  const statusCode = Number(res.statusCode || 0);
  const successfulResponse = statusCode > 0 && statusCode < 400;
  const originalPath = String(
    req.originalUrl || req.url || req.path || "",
  ).split("?")[0];

  // Leituras públicas bem-sucedidas são numerosas e já possuem cache e
  // métricas no Render. Erros, escritas, pagamentos, pedidos e rotas
  // administrativas continuam registrados normalmente.
  return successfulResponse && isPublicCachedReadRequest({
    method: req.method,
    path: originalPath,
  });
}

export function createRequestLogger(options = {}) {
  const nodeEnv = options.nodeEnv || env.nodeEnv;

  return morgan(nodeEnv === "production" ? "tiny" : "dev", {
    ...(options.stream ? { stream: options.stream } : {}),
    skip(req, res) {
      return shouldSkipRequestLog(req, res, nodeEnv);
    },
  });
}

export const requestLoggerMiddleware = createRequestLogger();
