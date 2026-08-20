import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(__filename), "..");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("reset usa uma única operação atômica no banco", () => {
  const source = read("routes/affiliatePassword.routes.js");
  const handler =
    source.match(/router\.post\("\/reset-password"[\s\S]*?export default router/)?.[0] || "";

  assert.match(handler, /\.rpc\(\s*"reset_affiliate_password_atomic"/);
  assert.doesNotMatch(handler, /\.from\("affiliates"\)/);
  assert.doesNotMatch(handler, /\.from\("affiliate_password_resets"\)/);
});

test("reset exige 12 caracteres e respeita limite de 72 bytes do bcrypt", () => {
  const source = read("routes/affiliatePassword.routes.js");
  assert.match(source, /password\.length >= 12/);
  assert.match(source, /BCRYPT_MAX_PASSWORD_BYTES = 72/);
  assert.match(source, /\[A-Z\]/);
  assert.match(source, /\[a-z\]/);
  assert.match(source, /\[0-9\]/);
});

test("autenticação principal não recria JWT e ponte legada é isolada", () => {
  const service = read("services/affiliatePortal.service.js");
  const middleware = read("middlewares/affiliateAuth.middleware.js");
  const bridge = read("services/affiliateLegacyBridge.service.js");

  assert.doesNotMatch(service, /signAffiliateToken|verifyAffiliateToken|jsonwebtoken/);
  assert.match(middleware, /getAffiliateSessionTokenFromRequest/);
  assert.match(middleware, /isAffiliateLegacyBridgeEnabled/);
  assert.match(bridge, /AFFILIATE_LEGACY_AUTH_BRIDGE/);
  assert.match(bridge, /48 \* 60 \* 60 \* 1000/);
});

test("middleware compara session_version com auth_token_version e revoga a linha", () => {
  const source = read("middlewares/affiliateAuth.middleware.js");
  assert.match(source, /getAffiliateSessionById/);
  assert.match(source, /Number\(session\.session_version\)/);
  assert.match(source, /Number\(affiliateSession\.authVersion\)/);
  assert.match(source, /revokeAffiliateSessionById\(session\.id, "auth_version_changed"\)/);
});

test("login executa bcrypt dummy para reduzir enumeração temporal", () => {
  const source = read("services/affiliatePortal.service.js");
  assert.match(source, /DUMMY_AFFILIATE_PASSWORD_HASH/);
  assert.match(source, /accountCanAuthenticate/);
  assert.match(source, /bcrypt\.compare/);
});

test("controller impõe duração mínima e Retry-After no bloqueio persistente", () => {
  const source = read("controllers/affiliatePortal.controller.js");
  assert.match(source, /enforceMinimumAffiliateLoginDuration/);
  assert.match(source, /setAffiliateLoginRetryAfter/);
});

test("migration consome token com bloqueio concorrente", () => {
  const source = read("sql/20260819-affiliate-secure-sessions-step1.sql");
  assert.match(source, /for update skip locked/i);
  assert.match(source, /used_at = v_now/i);
});

test("migration troca senha, incrementa versão e revoga sessões", () => {
  const source = read("sql/20260819-affiliate-secure-sessions-step1.sql");
  assert.match(source, /password_hash = p_password_hash/);
  assert.match(source, /auth_token_version = greatest\([\s\S]{0,140}\) \+ 1/);
  assert.match(source, /revoke_reason = 'password_reset'/);
});

test("criação de reset é atômica e somente um reset ativo permanece", () => {
  const source = read("sql/20260819-affiliate-secure-sessions-step1.sql");
  assert.match(source, /create_affiliate_password_reset_atomic/);
  assert.match(source, /uq_affiliate_password_resets_one_active|affiliate_password_resets/);
});

test("RPCs sensíveis não são executáveis por usuários públicos", () => {
  const source = read("sql/20260819-affiliate-secure-sessions-step1.sql");
  assert.match(source, /revoke all on function[\s\S]*from public, anon, authenticated/i);
  assert.match(source, /grant execute on function[\s\S]*to service_role/i);
});

test("check-email é compatível mas não consulta estado da conta", () => {
  const source = read("services/affiliatePortal.service.js");
  const handler =
    source.match(/export async function checkAffiliateAccessByEmail[\s\S]*$/)?.[0] || "";
  assert.match(handler, /exists:\s*null/);
  assert.doesNotMatch(handler, /findAffiliateByEmail|affiliate_applications/);
});

test("cadastro público não retorna indicador de conta existente", () => {
  const source = read("routes/store.routes.js");
  const handler =
    source.match(/router\.post\("\/affiliates\/apply"[\s\S]*?router\.get\("\/health"/)?.[0] || "";
  assert.match(handler, /status\(202\)/);
  assert.doesNotMatch(handler, /alreadyExists/);
  assert.doesNotMatch(handler, /application:/);
});



test("cadastro novo usa bcrypt cost 12 e valida recrutador antes da decisão de existência", () => {
  const source = read("routes/store.routes.js");
  assert.match(source, /bcrypt\.hash\(password, 12\)/);
  assert.match(source, /existingAffiliate, existingPending, recruiterAffiliate/);
  assert.match(source, /if \(recruiterRefCode && !recruiterAffiliate\?\.id\)/);
});

test("recuperação pública desacopla SMTP e uniformiza a latência visível", () => {
  const service = read("services/affiliatePortal.service.js");
  const controller = read("controllers/affiliatePortal.controller.js");
  const publicRoute = read("routes/affiliatePassword.routes.js");
  assert.match(service, /void notifyAffiliatePasswordReset/);
  assert.match(controller, /AFFILIATE_PASSWORD_RESET_MIN_RESPONSE_MS = 700/);
  assert.match(publicRoute, /PASSWORD_RESET_MIN_RESPONSE_MS = 700/);
  assert.match(controller, /crypto\.randomInt\(0, 121\)/);
});
