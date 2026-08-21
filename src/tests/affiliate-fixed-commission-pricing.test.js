import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  resolveAffiliateCommissionPercentForPricing,
} from "../services/adminPricing.service.js";

const __filename = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(__filename), "..");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("comissão fixa global sobrescreve o percentual enviado pela precificação", () => {
  const percent = resolveAffiliateCommissionPercentForPricing(
    { affiliate_commission_percent: 7.5 },
    { fixed_commission_enabled: true, fixed_commission_percent: 12.25 }
  );

  assert.equal(percent, 12.25);
});

test("configuração desativada preserva percentual por produto", () => {
  const percent = resolveAffiliateCommissionPercentForPricing(
    { affiliate_commission_percent: 7.5 },
    { fixed_commission_enabled: false, fixed_commission_percent: 12.25 }
  );

  assert.equal(percent, 7.5);
});

test("precificação injeta a comissão fixa antes de calcular preço sugerido", () => {
  const source = read("services/adminPricing.service.js");
  assert.match(source, /getAffiliateCommissionSettings\(\)/);
  assert.match(source, /resolveAffiliateCommissionPercentForPricing\([\s\S]{0,180}affiliateCommissionSettings/);
  assert.match(source, /affiliate_commission_percent:\s*affiliateCommissionPercent/);
});


test("falha ao carregar a nova configuração não quebra a precificação existente", () => {
  const source = read("services/adminPricing.service.js");
  assert.match(source, /PRICING_FIXED_COMMISSION_SETTINGS_FALLBACK/);
  assert.match(source, /return normalizeAffiliateCommissionSettings\(null\)/);
});

test("admin possui rotas protegidas para consultar e alterar comissão fixa", () => {
  const source = read("routes/adminPricing.routes.js");
  assert.ok(source.includes('router.get("/affiliate-settings", requirePricingView'));
  assert.ok(source.includes('router.patch("/affiliate-settings", requirePricingEdit'));
  assert.match(source, /affiliate_global_commission_updated/);
});

test("migration nasce desativada e restringe percentual entre zero e cem", () => {
  const source = read("sql/20260820-affiliate-fixed-commission-settings.sql");
  assert.match(source, /fixed_commission_enabled boolean not null default false/i);
  assert.match(source, /fixed_commission_percent >= 0[\s\S]*fixed_commission_percent <= 100/i);
  assert.match(source, /values \('global', false, null\)/i);
});
