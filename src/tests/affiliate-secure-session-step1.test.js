import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

function read(path) {
  return fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

test("middleware usa cookie por padrão e limita Bearer à ponte temporária", () => {
  const source = read("middlewares/affiliateAuth.middleware.js");
  const bridge = read("services/affiliateLegacyBridge.service.js");
  assert.match(source, /getAffiliateSessionTokenFromRequest/);
  assert.match(source, /isAffiliateLegacyBridgeEnabled/);
  assert.match(source, /authenticateLegacyBridge/);
  assert.doesNotMatch(source, /verifyAffiliateToken/);
  assert.match(bridge, /AFFILIATE_LEGACY_AUTH_BRIDGE_UNTIL/);
  assert.match(bridge, /LEGACY_BRIDGE_MAX_WINDOW_MS = 48 \* 60 \* 60 \* 1000/);
});

test("sessão do afiliado usa cookie HttpOnly e token opaco", () => {
  const source = read("services/affiliateSession.service.js");
  assert.match(source, /randomBytes\(SESSION_TOKEN_BYTES\)/);
  assert.match(source, /httpOnly:\s*true/);
  assert.match(source, /__Host-oz_affiliate_session/);
  assert.match(source, /assertAffiliateCsrfProtection/);
});

test("login possui guarda persistente por conta e IP", () => {
  const source = read("services/affiliateLoginGuard.service.js");
  assert.match(source, /hashAffiliateLoginIdentity/);
  assert.match(source, /hashAffiliateLoginIp/);
  assert.match(source, /affiliate_login_guard_failure/);
});

test("detector alerta o admin master", () => {
  const source = read("services/affiliateIntrusionDetection.service.js");
  assert.match(source, /is_master/);
  assert.match(source, /recipient_admin_id/);
  assert.match(source, /credential_stuffing/);
  assert.match(source, /affiliate_bruteforce/);
});

test("SQL protege sessões e telemetria por RLS", () => {
  const source = read("sql/20260819-affiliate-secure-sessions-step1.sql");
  assert.match(source, /alter table public\.affiliate_sessions enable row level security/i);
  assert.match(source, /revoke all on public\.affiliate_sessions from public, anon, authenticated/i);
  assert.match(source, /create_affiliate_single_session/i);
});
