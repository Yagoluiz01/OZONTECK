import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.PORT ||= "5000";
process.env.SUPABASE_URL ||= "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-role-key";
process.env.SUPABASE_ANON_KEY ||= "test-anon-key";
process.env.JWT_SECRET ||= "test-jwt-secret";
process.env.FRONTEND_URL ||= "http://localhost:5173";
process.env.STOCK_NOTIFICATIONS_ENABLED ||= "true";
process.env.STOCK_LOW_ALERT_THRESHOLD ||= "5";

const __filename = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(__filename), "..");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("classifica somente cruzamentos reais de estoque", async () => {
  const { classifyStockTransition } = await import(
    "../services/stockNotification.service.js"
  );

  assert.equal(
    classifyStockTransition({ previousStock: 1, currentStock: 0, lowStockThreshold: 5 }),
    "stock_out"
  );
  assert.equal(
    classifyStockTransition({ previousStock: 6, currentStock: 5, lowStockThreshold: 5 }),
    "stock_low"
  );
  assert.equal(
    classifyStockTransition({ previousStock: 5, currentStock: 4, lowStockThreshold: 5 }),
    null
  );
  assert.equal(
    classifyStockTransition({ previousStock: 0, currentStock: 0, lowStockThreshold: 5 }),
    null
  );
  assert.equal(
    classifyStockTransition({ previousStock: 0, currentStock: 10, lowStockThreshold: 5 }),
    null
  );
});

test("RPCs retornam transições calculadas dentro da transação", () => {
  const source = read("sql/security-integrity-hardening.sql");
  const migration = read("sql/20260817-stock-alert-transitions.sql");

  for (const sql of [source, migration]) {
    assert.match(sql, /'stock_changes', v_stock_changes/);
    assert.match(sql, /'previous_stock', v_previous_stock/);
    assert.match(sql, /'current_stock', v_current_stock/);
    assert.match(sql, /RETURNING stock_quantity, name, sku/);
  }

  assert.match(
    migration,
    /REVOKE ALL ON FUNCTION public\.create_store_order_atomic\(JSONB, JSONB\) FROM PUBLIC, anon, authenticated/
  );
  assert.match(
    migration,
    /GRANT EXECUTE ON FUNCTION public\.ensure_order_stock_reserved\(UUID\) TO service_role/
  );
});

test("serviço central de estoque dispara alertas após reservas", () => {
  const source = read("services/orderStock.service.js");

  assert.match(source, /notifyStockTransitionsSafely\(result\?\.stock_changes/);
  assert.match(source, /source: "order_creation_reservation"/);
  assert.match(source, /result\?\.reason === "reserved_again"/);
  assert.match(source, /source: "order_rereservation"/);
});

test("edição manual de produto também verifica a transição", () => {
  const source = read("routes/products.routes.js");

  assert.match(source, /notifySingleStockTransitionSafely/);
  assert.match(source, /previous_stock: previousStock/);
  assert.match(source, /current_stock: currentStock/);
  assert.match(source, /source: "admin_product_edit"/);
});
