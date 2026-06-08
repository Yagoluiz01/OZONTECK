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

test("marketing administrativo exige autenticação e master nas mutações", () => {
  const source = read("routes/adminAffiliateMarketing.routes.js");
  assert.match(source, /router\.use\(requireAdminAuth\)/);
  assert.match(source, /return requireMasterAdmin\(req, res, next\)/);
});

test("consultas de leads exigem admin master", () => {
  const source = read("routes/tracking.routes.js");
  assert.match(source, /router\.get\("\/checkout-leads", requireAdminAuth, requireMasterAdmin/);
  assert.match(source, /router\.get\("\/sessions", requireAdminAuth, requireMasterAdmin/);
  assert.match(source, /router\.get\("\/events", requireAdminAuth, requireMasterAdmin/);
});

test("ações de treinamento usam a identidade do token", () => {
  const source = read("routes/affiliateMarketing.routes.js");
  assert.match(source, /router\.post\('\/training\/complete', requireAffiliateAuth/);
  assert.match(source, /affiliate_id:\s*req\.affiliateId/);
});

test("simulação de pagamento exige master", () => {
  const source = read("routes/store.routes.js");
  assert.match(
    source,
    /router\.post\("\/payments\/simulate\/:orderNumber", requireAdminAuth, requireMasterAdmin/
  );
});

test("checkout usa criação atômica e número criptográfico", () => {
  const source = read("routes/store.routes.js");
  assert.match(source, /crypto\.randomBytes\(12\)/);
  assert.match(source, /createStoreOrderAtomic\(orderPayload, orderItemsPayload\)/);
});

test("webhook Mercado Pago exige assinatura e transição atômica", () => {
  const source = read("routes/store.routes.js");
  assert.match(source, /message: "Assinatura do webhook inválida\."/);
  assert.match(source, /applyMercadoPagoPaymentTransition\(/);
  assert.match(source, /claimOrderShippingLabelGeneration\(/);
});

test("liberação de comissão exige pagamento e entrega", () => {
  const source = read("services/affiliateCommissionLifecycle.service.js");
  assert.match(source, /const shouldRelease = isPaymentConfirmed && hasDeliveryConfirmation/);
});

test("migration contém estoque, idempotência, OAuth e unicidade", () => {
  const source = read("sql/security-integrity-hardening.sql");
  assert.match(source, /create_store_order_atomic/);
  assert.match(source, /release_order_stock/);
  assert.match(source, /apply_mercado_pago_payment_transition/);
  assert.match(source, /claim_order_shipping_label_generation/);
  assert.match(source, /integration_oauth_states/);
  assert.match(source, /uq_orders_order_number/);
  assert.match(source, /uq_affiliate_sale_commission_per_order/);
});

test("sessão administrativa é revalidada no banco", () => {
  const source = read("middlewares/auth.middleware.js");
  assert.match(source, /async function loadActiveAdmin/);
  assert.match(source, /\.from\("admins"\)/);
  assert.match(source, /data\.is_active !== true/);
});

test("cliente de checkout não pode ser reivindicado apenas pelo e-mail", () => {
  const source = read("routes/storeCustomerAccount.routes.js");
  assert.match(source, /CUSTOMER_EMAIL_REQUIRES_VERIFICATION/);
  assert.doesNotMatch(source, /activateExistingCustomer\(existingCustomer\.id, data, passwordHash\)/);
  assert.match(source, /customer\.account_enabled !== true/);
});

test("sessão do afiliado exige status ativo", () => {
  const source = read("services/affiliatePortal.service.js");
  assert.match(source, /const currentStatus = normalizeStatus/);
  assert.match(source, /\["active", "ativo"\]\.includes\(currentStatus\)/);
});

test("OAuth do Melhor Envio usa state aleatório, expirável e de uso único", () => {
  const routeSource = read("routes/shipping.routes.js");
  const stateSource = read("services/oauthState.service.js");
  assert.match(routeSource, /createIntegrationOAuthState/);
  assert.match(routeSource, /consumeIntegrationOAuthState/);
  assert.match(stateSource, /crypto\.randomBytes\(32\)/);
  assert.match(stateSource, /consumed_at/);
});

test("webhook do Melhor Envio não usa correspondência aproximada", () => {
  const source = read("services/melhorEnvioWebhook.service.js");
  assert.doesNotMatch(source, /ilike/i);
  assert.doesNotMatch(source, /includes\(.*identifier/i);
  assert.match(source, /ambiguous/i);
});

test("uploads possuem limite e validação de assinatura real", () => {
  const productSource = read("routes/products.routes.js");
  const marketingSource = read("routes/adminAffiliateMarketing.routes.js");
  assert.match(productSource, /fileSize:\s*MAX_PRODUCT_IMAGE_BYTES/);
  assert.match(productSource, /detectProductImageType/);
  assert.match(marketingSource, /MAX_MARKETING_UPLOAD_BYTES/);
  assert.match(marketingSource, /detectMarketingUploadType/);
});

test("limite JSON alto fica isolado no módulo de upload", () => {
  const source = read("app.js");
  assert.doesNotMatch(source, /express\.json\(\{[\s\S]{0,80}limit:\s*"80mb"/);
  assert.match(source, /"\/api\/admin\/affiliate-marketing"[\s\S]{0,120}limit:\s*"70mb"/);
  assert.match(source, /app\.use\(express\.json\(\{ limit: "2mb" \}\)\)/);
});

test("produção recusa simulação de pagamento ativa", () => {
  const source = read("config/env.js");
  assert.match(source, /nodeEnv === "production"/);
  assert.match(source, /ENABLE_PAYMENT_SIMULATION não pode permanecer ativo/);
});
