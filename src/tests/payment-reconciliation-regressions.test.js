import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const storeSource = fs.readFileSync(new URL("../routes/store.routes.js", import.meta.url), "utf8");
const serverSource = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
const reconciliationSource = fs.readFileSync(
  new URL("../jobs/reconcilePendingMercadoPagoPayments.js", import.meta.url),
  "utf8"
);

test("reconcile-payment pode recuperar o payment_reference oficial do pedido", () => {
  assert.match(storeSource, /paymentId = String\(order\.payment_reference \|\| ""\)\.trim\(\)/);
  assert.match(storeSource, /hasVerifiedOrderAccess\(req, order\)/);
});

test("conciliação automática valida referência, valor e moeda antes de alterar pedido", () => {
  assert.match(reconciliationSource, /externalReference === orderNumber/);
  assert.match(reconciliationSource, /Math\.abs\(expectedAmount - receivedAmount\) <= 0\.01/);
  assert.match(reconciliationSource, /currency === "BRL"/);
  assert.match(reconciliationSource, /applyMercadoPagoPaymentTransition/);
});

test("servidor agenda conciliação periódica de pagamentos", () => {
  assert.match(serverSource, /MERCADO_PAGO_RECONCILE_ENABLED/);
  assert.match(serverSource, /runPaymentReconciliation/);
  assert.match(serverSource, /reconcilePendingMercadoPagoPayments/);
});
