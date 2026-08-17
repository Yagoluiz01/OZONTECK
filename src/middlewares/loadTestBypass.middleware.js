import crypto from "node:crypto";

const TOKEN_PREFIX = "OZLoadTest/";
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

function readSignedAgentToken(req = {}) {
  const userAgent = String(req.get?.("user-agent") || req.headers?.["user-agent"] || "");
  const markerIndex = userAgent.indexOf(TOKEN_PREFIX);
  if (markerIndex < 0) return null;

  const raw = userAgent.slice(markerIndex + TOKEN_PREFIX.length).split(/\s|;/, 1)[0];
  const [timestampRaw, nonce, signature] = raw.split(".");
  if (!timestampRaw || !nonce || !signature) return null;

  const timestamp = Number(timestampRaw);
  if (!Number.isFinite(timestamp)) return null;
  if (!/^[a-f0-9]{16,64}$/i.test(nonce)) return null;
  if (!/^[a-f0-9]{64}$/i.test(signature)) return null;

  return { timestamp, nonce, signature };
}

// Desativado por padrão. O bypass só existe quando LOAD_TEST_KEY está definido.
// Suporta o header legado para chamadas servidor-servidor e, para navegador,
// um token HMAC curto embutido no User-Agent. Isso evita preflight CORS em cada fetch.
export function isAuthorizedLoadTestRequest(req = {}) {
  const secret = String(process.env.LOAD_TEST_KEY || "").trim();
  if (!secret) return false;

  const receivedHeader = String(req.get?.("x-oz-load-test-key") || "").trim();
  if (receivedHeader && safeEqual(receivedHeader, secret)) return true;

  const token = readSignedAgentToken(req);
  if (!token) return false;

  const ageMs = Math.abs(Date.now() - token.timestamp);
  if (ageMs > getTokenTtlMs()) return false;

  const expected = expectedSignature(secret, token.timestamp, token.nonce);
  return safeEqual(token.signature, expected);
}
