import assert from "node:assert/strict";
import test from "node:test";
import { buildStockIntelligenceProduct, normalizeStockIntelligenceSettings } from "../services/stock.service.js";

const NOW = new Date("2026-08-17T22:00:00.000Z");
const baseProduct = {
  id: "p1",
  name: "Produto teste",
  sku: "SKU-1",
  status: "active",
  stock_quantity: 10,
  cost_price: 20,
  price: 50,
  created_at: "2026-01-01T00:00:00.000Z",
};

test("estoque zerado sempre é classificado como ruptura", () => {
  const result = buildStockIntelligenceProduct(
    { ...baseProduct, stock_quantity: 0 },
    { units30: 30, units7: 7, units60: 60, lastSaleAt: "2026-08-16T00:00:00.000Z" },
    {},
    NOW
  );
  assert.equal(result.risk, "out_of_stock");
  assert.equal(result.coverageDays, 0);
});

test("produto com cobertura abaixo do lead time mais segurança vira crítico", () => {
  const result = buildStockIntelligenceProduct(
    { ...baseProduct, stock_quantity: 10 },
    { units30: 30, units7: 7, units60: 60, lastSaleAt: "2026-08-16T00:00:00.000Z" },
    { leadTimeDays: 7, safetyDays: 7 },
    NOW
  );
  assert.equal(result.risk, "critical");
  assert.ok(result.suggestedPurchaseQty > 0);
});

test("produto maduro sem venda recente identifica capital parado", () => {
  const result = buildStockIntelligenceProduct(
    { ...baseProduct, stock_quantity: 12, cost_price: 25 },
    { units30: 0, units7: 0, units60: 0, lastSaleAt: "2026-05-01T00:00:00.000Z" },
    { stagnantDays: 60 },
    NOW
  );
  assert.equal(result.risk, "stagnant");
  assert.equal(result.capitalTied, 300);
});

test("produto novo sem histórico não é marcado prematuramente como parado", () => {
  const result = buildStockIntelligenceProduct(
    { ...baseProduct, created_at: "2026-08-10T00:00:00.000Z", stock_quantity: 12 },
    {},
    { stagnantDays: 60 },
    NOW
  );
  assert.equal(result.risk, "no_history");
});

test("sem histórico pago global, produto antigo fica sem histórico em vez de falso capital parado", () => {
  const result = buildStockIntelligenceProduct(
    { ...baseProduct, stock_quantity: 12, cost_price: 25 },
    { units30: 0, units7: 0, units60: 0 },
    { stagnantDays: 60, hasGlobalSalesHistory: false },
    NOW
  );
  assert.equal(result.risk, "no_history");
  assert.equal(result.capitalTied, 0);
});

test("parâmetros recebidos pela rota ficam dentro de limites seguros", () => {
  const settings = normalizeStockIntelligenceSettings({
    analysisDays: 9999,
    leadTimeDays: -5,
    targetCoverageDays: 1,
  });
  assert.equal(settings.analysisDays, 90);
  assert.equal(settings.leadTimeDays, 1);
  assert.equal(settings.targetCoverageDays, 7);
});
