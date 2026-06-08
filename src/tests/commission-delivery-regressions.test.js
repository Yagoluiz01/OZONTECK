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

test("admin não pode confirmar entrega manualmente", () => {
  const source = read("routes/orders.routes.js");
  assert.match(source, /normalizedStatus === "delivered" && !orderWasAlreadyDelivered[\s\S]{0,280}DELIVERY_REQUIRES_CARRIER_CONFIRMATION/);
  assert.doesNotMatch(source, /normalizedStatus === "delivered"[\s\S]{0,100}updatePayload\.delivered_at/);
});

test("liberação exige fonte oficial do Melhor Envio", () => {
  const source = read("services/affiliateCommissionLifecycle.service.js");
  assert.match(source, /TRUSTED_DELIVERY_RELEASE_SOURCES/);
  assert.match(source, /melhor_envio_webhook_order_delivered/);
  assert.match(source, /melhor_envio_label_sync/);
  assert.match(source, /const shouldRelease =[\s\S]{0,180}trustedDeliverySource/);
  assert.match(source, /delivery_source_not_trusted/);
});

test("falha de consulta ou atualização de comissão não vira sucesso silencioso", () => {
  const source = read("services/affiliateCommissionLifecycle.service.js");
  assert.match(source, /Falha ao consultar as comissões do pedido/);
  assert.match(source, /response\.ok && rows\.length === 1/);
  assert.match(source, /failedResults\.length \|\| productGoalFailed/);
  assert.match(source, /throw createLifecycleError/);
});

test("bônus por produto fica sob responsabilidade exclusiva do ciclo próprio", () => {
  const source = read("services/affiliateCommissionLifecycle.service.js");
  assert.match(source, /isProductGoalBonusConversion\(conversion\)[\s\S]{0,220}managed_by_product_goal_lifecycle/);
});

test("webhook de entrega pede nova tentativa quando não conclui o ciclo", () => {
  const source = read("services/melhorEnvioWebhook.service.js");
  assert.match(source, /MELHOR_ENVIO_DELIVERED_ORDER_NOT_FOUND/);
  assert.match(source, /AFFILIATE_LIFECYCLE_NOT_COMPLETED/);
  assert.match(source, /error\.statusCode = 503/);
});

test("sincronização mantém pedido elegível para retry até liberar comissão", () => {
  const source = read("services/shipping.service.js");
  const lifecycleCall = source.indexOf("await syncAffiliateCommissionAfterShippingUpdate");
  const finalStatus = source.indexOf('shipping_label_status: "delivered"', lifecycleCall);
  assert.ok(lifecycleCall >= 0, "chamada do ciclo de comissão ausente");
  assert.ok(finalStatus > lifecycleCall, "status finalizado antes do ciclo de comissão");
  assert.match(source, /throw error;/);
});

test("saldo do admin usa status ou released_at da comissão", () => {
  const source = read("services/adminAffiliates.service.js");
  assert.match(source, /isCommissionReleasedLikeStatus\(conversion\.status\)[\s\S]{0,90}conversion\.released_at/);
  assert.doesNotMatch(source, /if \(isAdminOrderDelivered\(order\)\) \{\s*return "delivered"/);
});

test("saldo do afiliado não é liberado apenas pelo status entregue do pedido", () => {
  const source = read("services/affiliatePortal.service.js");
  assert.match(source, /function isConversionFormallyReleased/);
  assert.match(source, /delivery_confirmed_pending_release/);
  assert.doesNotMatch(source, /if \(lifecycle === "delivered"\) \{\s*acc\.released_commission/);
});
