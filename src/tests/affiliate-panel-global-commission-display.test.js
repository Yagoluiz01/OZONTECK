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

test("resumo do afiliado carrega a regra global de recrutamento", () => {
  const source = read("services/affiliatePortal.service.js");
  assert.match(source, /from\("affiliate_commission_settings"\)/);
  assert.match(source, /\.eq\("id", "global"\)/);
  assert.match(source, /fixed_recruitment_commission_enabled/);
  assert.match(source, /global_recruitment_commission_percent/);
  assert.match(source, /commission_policy:\s*commissionPolicy/);
});

test("controller expõe a política para o painel do afiliado", () => {
  const source = read("controllers/affiliatePortal.controller.js");
  assert.match(source, /commission_policy:\s*result\.commission_policy/);
  assert.match(source, /export async function commissionPolicy/);
  assert.match(source, /getAffiliateCommissionPolicy\(affiliate\)/);
});

test("rota autenticada dedicada expõe a política sem depender do summary", () => {
  const source = read("routes/affiliatePortal.routes.js");
  assert.match(
    source,
    /router\.get\("\/commission-policy", requireAffiliateAuth, commissionPolicy\)/
  );
});
