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

test("reset mantém a complexidade da senha do cadastro", () => {
  const source = read("routes/affiliatePassword.routes.js");
  assert.match(source, /password\.length >= 8/);
  assert.match(source, /\[A-Z\]/);
  assert.match(source, /\[a-z\]/);
  assert.match(source, /\[0-9\]/);
});

test("JWT possui versão revogável e algoritmo fixo", () => {
  const source = read("services/affiliatePortal.service.js");
  assert.match(source, /auth_version: Number\(affiliate\.auth_token_version \|\| 1\)/);
  assert.match(source, /algorithm: "HS256"/);
  assert.match(source, /algorithms: \["HS256"\]/);
});

test("middleware compara a versão do token com o banco", () => {
  const source = read("middlewares/affiliateAuth.middleware.js");
  assert.match(source, /getAffiliateSessionById/);
  assert.match(source, /Number\(decoded\.auth_version\)/);
  assert.match(source, /tokenAuthVersion !== session\.authVersion/);
  assert.match(source, /Sessão do afiliado revogada/);
});

test("migration consome token com bloqueio concorrente", () => {
  const source = read("sql/20260814-affiliate-password-reset-hardening.sql");
  assert.match(source, /for update skip locked/i);
  assert.match(source, /used_at = v_now/i);
  assert.match(source, /if not found then/i);
});

test("migration troca senha e incrementa a versão na mesma função", () => {
  const source = read("sql/20260814-affiliate-password-reset-hardening.sql");
  assert.match(source, /password_hash = p_password_hash/);
  assert.match(source, /auth_token_version = greatest\([\s\S]{0,140}\) \+ 1/);
  assert.match(source, /password_changed_at = v_now/);
});

test("somente um reset ativo pode existir por afiliado", () => {
  const source = read("sql/20260814-affiliate-password-reset-hardening.sql");
  assert.match(source, /uq_affiliate_password_resets_one_active/);
  assert.match(source, /where used_at is null/);
});

test("RPC não é executável por usuários públicos", () => {
  const source = read("sql/20260814-affiliate-password-reset-hardening.sql");
  assert.match(source, /revoke all on function[\s\S]{0,160}from public, anon, authenticated/i);
  assert.match(source, /grant execute on function[\s\S]{0,160}to service_role/i);
});

