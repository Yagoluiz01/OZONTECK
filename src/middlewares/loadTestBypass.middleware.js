import crypto from "node:crypto";

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  if (!left.length || left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

// Desativado por padrão. Só ignora limitadores quando o servidor possui
// LOAD_TEST_KEY e a mesma chave é enviada explicitamente pelo runner.
export function isAuthorizedLoadTestRequest(req = {}) {
  const expected = String(process.env.LOAD_TEST_KEY || "").trim();
  if (!expected) return false;
  const received = String(req.get?.("x-oz-load-test-key") || "").trim();
  return safeEqual(received, expected);
}
