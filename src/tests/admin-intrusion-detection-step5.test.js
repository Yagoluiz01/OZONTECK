import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const apiRoot = path.resolve(__dirname, "../..");

function read(rel) {
  return fs.readFileSync(path.join(apiRoot, rel), "utf8");
}

test("login usa duas camadas de limitação: IP e conta persistente", () => {
  const limiter = read("src/middlewares/rate-limit.middleware.js");
  const guard = read("src/services/adminLoginGuard.service.js");

  assert.match(limiter, /adminAuthLimiter[\s\S]*max:\s*8/);
  assert.match(limiter, /skipSuccessfulRequests:\s*true/);
  assert.match(guard, /DEFAULT_MAX_FAILURES\s*=\s*8/);
  assert.match(guard, /DEFAULT_BLOCK_MINUTES\s*=\s*15/);
});

test("detector correlaciona brute force, credential stuffing e ataque distribuído", () => {
  const detector = read("src/services/adminIntrusionDetection.service.js");

  assert.match(detector, /credential_stuffing/);
  assert.match(detector, /distributed_account_attack/);
  assert.match(detector, /successful_login_after_failures/);
  assert.match(detector, /master_account_attack/);
  assert.match(detector, /createDeduplicatedSecurityEvent/);
});

test("telemetria sensível usa HMAC e não grava IP bruto no payload", () => {
  const detector = read("src/services/adminIntrusionDetection.service.js");

  assert.match(detector, /createHmac\("sha256"/);
  assert.match(detector, /ip_hash:\s*ipHash/);
  assert.doesNotMatch(detector, /ip_address\s*:/);
});

test("notificação de segurança é direcionada ao master e push respeita destinatário", () => {
  const detector = read("src/services/adminIntrusionDetection.service.js");
  const notifications = read("src/services/adminNotifications.service.js");
  const push = read("src/services/adminPush.service.js");

  assert.match(detector, /\.eq\("is_master", true\)/);
  assert.match(detector, /recipient_admin_id:\s*master\.id/);
  assert.match(notifications, /recipient_admin_id:\s*payload\.recipient_admin_id/);
  assert.match(push, /notification\?\.recipient_admin_id/);
  assert.match(push, /\.eq\(\s*"admin_id"/);
});

test("SQL bloqueia acesso cliente às tabelas de detecção e deduplica alertas", () => {
  const sql = read("src/sql/20260819-admin-intrusion-detection-step5.sql");

  assert.match(sql, /enable row level security/i);
  assert.match(sql, /revoke all on table public\.admin_login_security_attempts from public, anon, authenticated/i);
  assert.match(sql, /revoke all on table public\.admin_security_events from public, anon, authenticated/i);
  assert.match(sql, /dedupe_key text not null unique/i);
  assert.match(sql, /recipient_admin_id uuid/i);
});

test("rota de notificações lista somente globais + destinadas ao admin autenticado", () => {
  const routes = read("src/routes/adminNotifications.routes.js");
  const service = read("src/services/adminNotifications.service.js");

  assert.match(routes, /recipientAdminId:\s*req\.admin\?\.id/);
  assert.match(service, /recipient_admin_id\.is\.null,recipient_admin_id\.eq/);
  assert.match(routes, /router\.post\("\/", requirePermission\("notifications\.edit"\)/);
});
