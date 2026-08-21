import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  resolveAffiliateCommissionPercentForPricing,
  resolveRecruitmentCommissionPercentForPricing,
} from "../services/adminPricing.service.js";

const __filename = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(__filename), "..");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("comissão direta global sobrescreve o percentual enviado pela precificação", () => {
  const percent = resolveAffiliateCommissionPercentForPricing(
    { affiliate_commission_percent: 7.5 },
    { fixed_commission_enabled: true, fixed_commission_percent: 12.25 }
  );
  assert.equal(percent, 12.25);
});

test("comissão global de recrutamento sobrescreve a comissão de rede do produto", () => {
  const percent = resolveRecruitmentCommissionPercentForPricing(
    { network_commission_percent: 3.5 },
    {
      fixed_recruitment_commission_enabled: true,
      fixed_recruitment_commission_percent: 6.75,
    }
  );
  assert.equal(percent, 6.75);
});

test("regras globais desativadas preservam os percentuais existentes", () => {
  assert.equal(
    resolveAffiliateCommissionPercentForPricing(
      { affiliate_commission_percent: 7.5 },
      { fixed_commission_enabled: false, fixed_commission_percent: 12.25 }
    ),
    7.5
  );
  assert.equal(
    resolveRecruitmentCommissionPercentForPricing(
      { network_commission_percent: 4.25 },
      {
        fixed_recruitment_commission_enabled: false,
        fixed_recruitment_commission_percent: 9,
      }
    ),
    4.25
  );
});

test("precificação injeta comissão direta e recrutamento globais antes do cálculo", () => {
  const source = read("services/adminPricing.service.js");
  assert.match(source, /resolveAffiliateCommissionPercentForPricing\([\s\S]{0,180}affiliateCommissionSettings/);
  assert.match(source, /resolveRecruitmentCommissionPercentForPricing\([\s\S]{0,180}affiliateCommissionSettings/);
  assert.match(source, /affiliate_commission_percent:\s*affiliateCommissionPercent/);
  assert.match(source, /network_commission_percent:\s*recruitmentCommissionPercent/);
});

test("checkout usa a regra global imediatamente nas novas vendas", () => {
  const source = read("routes/store.routes.js");
  assert.match(source, /fetchGlobalAffiliateCommissionOverrides/);
  assert.match(source, /globalRecruitmentRate:\s*globalCommissionOverrides\.recruitmentRate/);
  assert.match(source, /globalSellerRate:\s*globalCommissionOverrides\.sellerRate/);
  assert.match(source, /globalRecruitmentRate[^\n]*[\s\S]{0,180}pricing\.network_commission_percent/);
});


test("precificação transforma a comissão de recrutamento em custo monetário por unidade", () => {
  const source = read("services/adminPricing.service.js");
  assert.match(
    source,
    /networkCommissionValue\s*=\s*roundMoney\([\s\S]{0,120}price \* \(normalizePercent\(networkCommissionPercent\) \/ 100\)/
  );
  assert.match(source, /profit[\s\S]{0,220}networkCommissionValue/);
});

test("regra global continua respeitando o piso nominal por unidade", () => {
  const source = read("routes/store.routes.js");
  assert.match(source, /networkFloorPerUnit/);
  assert.match(source, /Math\.max\(networkPercentAmount, networkFloorAmount\)/);
});

test("rotas administrativas consultam e alteram a configuração global", () => {
  const source = read("routes/adminPricing.routes.js");
  assert.ok(source.includes('router.get("/affiliate-settings", requirePricingView'));
  assert.ok(source.includes('router.patch("/affiliate-settings", requirePricingEdit'));
  assert.match(source, /affiliate_global_commission_updated/);
});

test("migration v2 cria campos globais de recrutamento desativados por padrão", () => {
  const source = read("sql/20260820-affiliate-global-commission-settings-v2.sql");
  assert.match(source, /fixed_recruitment_commission_enabled boolean not null default false/i);
  assert.match(source, /fixed_recruitment_commission_percent >= 0[\s\S]*fixed_recruitment_commission_percent <= 100/i);
  assert.match(source, /values \('global', false, false\)/i);
});
