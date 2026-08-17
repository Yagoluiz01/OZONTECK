import crypto from "node:crypto";

const TOKEN_PREFIX = "OZLoadTest/";
const LANGUAGE_TOKEN_PREFIX = "ozlt=";
const DEFAULT_TOKEN_TTL_MS = 15 * 60 * 1000;
const MAX_TOKEN_TTL_MS = 30 * 60 * 1000;

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  if (!left.length || left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function getTokenTtlMs() {
  const configured = Number(process.env.LOAD_TEST_TOKEN_TTL_MS || DEFAULT_TOKEN_TTL_MS);
  if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_TOKEN_TTL_MS;
  return Math.min(configured, MAX_TOKEN_TTL_MS);
}

function expectedSignature(secret, timestamp, nonce) {
  return crypto
    .createHmac("sha256", secret)
    .update(`ozonteck-load-test-v1:${timestamp}:${nonce}`)
    .digest("hex");
}

function parseSignedToken(rawToken) {
  const raw = String(rawToken || "").trim();
  const [timestampRaw, nonce, signature] = raw.split(".");
  if (!timestampRaw || !nonce || !signature) return null;

  const timestamp = Number(timestampRaw);
  if (!Number.isFinite(timestamp)) return null;
  if (!/^[a-f0-9]{16,64}$/i.test(nonce)) return null;
  if (!/^[a-f0-9]{64}$/i.test(signature)) return null;

  return { timestamp, nonce, signature };
}

function readSignedLanguageToken(req = {}) {
  const language = String(
    req.get?.("accept-language") || req.headers?.["accept-language"] || ""
  );

  const markerIndex = language.toLowerCase().indexOf(LANGUAGE_TOKEN_PREFIX);
  if (markerIndex < 0) return null;

  const raw = language
    .slice(markerIndex + LANGUAGE_TOKEN_PREFIX.length)
    .split(/[\s,;]/, 1)[0];

  return parseSignedToken(raw);
}

const SAFE_QUERY_TOKEN_PATHS = new Set([
  "/api/tracking/events/batch",
  "/api/tracking/checkout-contact",
  "/api/tracking/session/end",
]);

function getRequestPath(req = {}) {
  const raw = String(req.originalUrl || req.url || req.path || "");
  return raw.split("?", 1)[0];
}

function readSignedQueryToken(req = {}) {
  if (!SAFE_QUERY_TOKEN_PATHS.has(getRequestPath(req))) return null;

  const direct = req.query?.ozlt;
  if (direct) return parseSignedToken(Array.isArray(direct) ? direct[0] : direct);

  const rawUrl = String(req.originalUrl || req.url || "");
  const queryIndex = rawUrl.indexOf("?");
  if (queryIndex < 0) return null;

  try {
    const params = new URLSearchParams(rawUrl.slice(queryIndex + 1));
    return parseSignedToken(params.get("ozlt"));
  } catch {
    return null;
  }
}

function readSignedAgentToken(req = {}) {
  const userAgent = String(req.get?.("user-agent") || req.headers?.["user-agent"] || "");
  const markerIndex = userAgent.indexOf(TOKEN_PREFIX);
  if (markerIndex < 0) return null;

  const raw = userAgent.slice(markerIndex + TOKEN_PREFIX.length).split(/\s|;/, 1)[0];
  return parseSignedToken(raw);
}

function isValidSignedToken(secret, token) {
  if (!token) return false;

  const ageMs = Math.abs(Date.now() - token.timestamp);
  if (ageMs > getTokenTtlMs()) return false;

  const expected = expectedSignature(secret, token.timestamp, token.nonce);
  return safeEqual(token.signature, expected);
}

// Desativado por padrão. Só funciona quando LOAD_TEST_KEY está definido no Render.
// Ordem de leitura:
// 1) header legado x-oz-load-test-key (servidor-servidor);
// 2) token HMAC temporário na query, aceito APENAS em endpoints públicos de tracking;
// 3) token HMAC em Accept-Language, mantido para compatibilidade;
// 4) token antigo no User-Agent, mantido para compatibilidade.
export function isAuthorizedLoadTestRequest(req = {}) {
  const secret = String(process.env.LOAD_TEST_KEY || "").trim();
  if (!secret) return false;

  const receivedHeader = String(req.get?.("x-oz-load-test-key") || "").trim();
  if (receivedHeader && safeEqual(receivedHeader, secret)) return true;

  const queryToken = readSignedQueryToken(req);
  if (isValidSignedToken(secret, queryToken)) return true;

  const languageToken = readSignedLanguageToken(req);
  if (isValidSignedToken(secret, languageToken)) return true;

  const agentToken = readSignedAgentToken(req);
  return isValidSignedToken(secret, agentToken);
}
