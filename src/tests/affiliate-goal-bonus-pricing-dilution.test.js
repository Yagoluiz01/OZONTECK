import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { calculatePricing } from "../services/adminPricing.service.js";

const __filename = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(__filename), "..");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

const BASE_INPUT = {
  affiliate_program_enabled: true,
  goal_funding_mode: "legacy_unit_provision",
  cost_price: 50,
  packaging_cost: 0,
  traffic_cost: 0,
  operational_cost: 0,
  other_costs: 0,
  average_shipping_cost: 0,
  gateway_fee_percent: 0,
  tax_percent: 0,
  desired_margin_percent: 20,
  minimum_company_margin_percent: 20,
  affiliate_commission_percent: 10,
  max_affiliate_commission_percent: 10,
  special_affiliate_commission_percent: 10,
  commission_scenario_percent: 10,
  network_commission_percent: 5,
};

test("bônus monetário da meta é diluído pela quantidade mínima de vendas", () => {
  const pricing = calculatePricing({
    ...BASE_INPUT,
    affiliate_goal_levels: [
      {
        name: "Bronze",
        level_order: 1,
        required_conversions: 10,
        bonus_amount: 100,
        bonus_type: "fixed",
        is_active: true,
      },
    ],
  });

  assert.equal(pricing.goal_bonus_per_sale, 10);
  assert.equal(pricing.goal_bonus_value, 10);
  assert.equal(pricing.goal_funding_mode, "legacy_unit_provision");
  assert.equal(pricing.goal_fund_reserve_percent, 0);
  assert.equal(pricing.suggested_price, 92.31);
});

test("metas progressivas usam o pior custo acumulado por venda", () => {
  const pricing = calculatePricing({
    ...BASE_INPUT,
    affiliate_goal_levels: [
      {
        name: "Bronze",
        level_order: 1,
        required_conversions: 5,
        bonus_amount: 30,
        bonus_type: "fixed",
        is_active: true,
      },
      {
        name: "Prata",
        level_order: 2,
        required_conversions: 10,
        bonus_amount: 90,
        bonus_type: "fixed",
        is_active: true,
      },
    ],
  });

  // Bronze: 30 / 5 = 6. Prata: (30 + 90) / 10 = 12.
  assert.equal(pricing.goal_bonus_per_sale, 12);
  assert.equal(pricing.worst_goal_level_name, "Prata");
});

test("recompensa manual sem custo monetário automático não entra na precificação", () => {
  const pricing = calculatePricing({
    ...BASE_INPUT,
    affiliate_goal_levels: [
      {
        name: "Kit manual",
        level_order: 1,
        required_conversions: 5,
        bonus_amount: 500,
        bonus_type: "manual",
        is_active: true,
      },
    ],
  });

  assert.equal(pricing.goal_bonus_per_sale, 0);
});

test("checkout provisiona o bônus diluído por unidade no modo unitário", () => {
  const source = read("routes/store.routes.js");
  assert.match(source, /goalBonusProvisionPerUnit/);
  assert.match(source, /pricing\.goal_bonus_per_sale/);
  assert.match(source, /roundMoney\(goalBonusProvisionPerUnit \* quantity\)/);
  assert.match(source, /goalBonusProvisionAmount \+= reserveAmount/);
  assert.match(source, /estimatedProfit[\s\S]{0,260}goalFundReserveAmount/);
});

test("precificação persiste o modo unitário e o provisionamento das metas", () => {
  const source = read("services/adminPricing.service.js");
  assert.match(source, /goal_funding_mode:\s*goalFundingMode/);
  assert.match(source, /goal_fund_reserve_value:[\s\S]{0,120}goalBonusPerSale/);
  assert.match(source, /goal_bonus_liability_value:\s*roundMoney\(goalBonusPerSale\)/);
});
