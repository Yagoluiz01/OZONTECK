import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.PORT ||= "5056";
process.env.SUPABASE_URL ||= "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-role-key";
process.env.SUPABASE_ANON_KEY ||= "test-anon-key";
process.env.JWT_SECRET ||= "test-jwt-secret-with-enough-entropy";
process.env.FRONTEND_URL ||= "https://loja.example.com";
process.env.API_BASE_URL ||= "https://api.example.com";
process.env.WEB_PUSH_PUBLIC_KEY ||= "test-web-push-public-key";
process.env.WEB_PUSH_PRIVATE_KEY ||= "test-web-push-private-key";
process.env.WEB_PUSH_CONTACT_EMAIL ||= "push@example.com";

const __filename = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(__filename), "..");
const workspaceRoot = process.env.OZONTECK_WORKSPACE_ROOT
  ? path.resolve(process.env.OZONTECK_WORKSPACE_ROOT)
  : path.resolve(root, "../..");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function event({ type, createdAt, category = "Perfumes Masculinos", sessionId = "session-1" }) {
  return {
    visitor_id: "visitor-1",
    session_id: sessionId,
    event_type: type,
    page: "detalhe-produto.html",
    section: JSON.stringify({
      product_id: "product-1",
      product_name: "Perfume Teste",
      category,
      product_price: 199.9,
    }),
    created_at: createdAt,
  };
}

test("taxonomia compartilhada agrupa variações masculinas sem misturar outros públicos", async () => {
  const { normalizeInterestCategory } = await import(
    "../intelligence/interestTaxonomy.js"
  );

  assert.equal(normalizeInterestCategory("Perfumes Masculinos"), "perfumes_masculinos");
  assert.equal(normalizeInterestCategory("perfume masculino"), "perfumes_masculinos");
  assert.equal(normalizeInterestCategory("MASCULINOS"), "perfumes_masculinos");
  assert.equal(normalizeInterestCategory("Perfume Feminino"), "perfumes_femininos");
  assert.equal(normalizeInterestCategory("Fragrância Unissex"), "perfumes_unissex");
  assert.equal(normalizeInterestCategory("Skincare"), "cuidados_pele");
  assert.notEqual(
    normalizeInterestCategory("Perfume Masculino"),
    normalizeInterestCategory("Perfume Feminino")
  );
});

test("uma impressão superficial não torna o cliente elegível", async () => {
  const {
    buildCustomerInterestProfileRows,
    evaluateInterestEligibility,
  } = await import("../services/customerInterestProfile.service.js");
  const nowMs = Date.parse("2026-08-24T12:00:00.000Z");
  const projection = buildCustomerInterestProfileRows(
    [event({ type: "product_view", createdAt: "2026-08-24T11:59:00.000Z" })],
    {
      customerId: "11111111-1111-4111-8111-111111111111",
      nowMs,
      learningStartAt: "2026-08-01T00:00:00.000Z",
    }
  );

  assert.equal(projection.rows.length, 1);
  assert.equal(projection.rows[0].qualifying_signal_count, 0);
  const result = evaluateInterestEligibility(projection.rows[0], {}, nowMs);
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.includes("qualifying_signals_missing"));
});

test("detalhe e carrinho recentes tornam perfume masculino elegível", async () => {
  const {
    buildCustomerInterestProfileRows,
    evaluateInterestEligibility,
  } = await import("../services/customerInterestProfile.service.js");
  const nowMs = Date.parse("2026-08-24T12:00:00.000Z");
  const projection = buildCustomerInterestProfileRows(
    [
      event({ type: "product_detail_view", createdAt: "2026-08-24T11:56:00.000Z" }),
      event({ type: "product_add_confirmed", createdAt: "2026-08-24T11:58:00.000Z" }),
    ],
    {
      customerId: "11111111-1111-4111-8111-111111111111",
      nowMs,
      learningStartAt: "2026-08-01T00:00:00.000Z",
    }
  );

  const profile = projection.rows.find(
    (row) => row.category_key === "perfumes_masculinos"
  );
  assert.ok(profile);
  assert.equal(profile.qualifying_signal_count, 2);
  const result = evaluateInterestEligibility(profile, {}, nowMs);
  assert.equal(result.eligible, true);
  assert.ok(result.matchScore >= 55);
});

test("decaimento de 72 horas reduz sinais antigos", async () => {
  const { calculateInterestRecencyScore } = await import(
    "../services/customerInterestProfile.service.js"
  );
  const nowMs = Date.parse("2026-08-24T12:00:00.000Z");

  assert.equal(calculateInterestRecencyScore(new Date(nowMs).toISOString(), { nowMs }), 100);
  assert.equal(
    calculateInterestRecencyScore(new Date(nowMs - 72 * 60 * 60 * 1000).toISOString(), {
      nowMs,
    }),
    50
  );
  assert.equal(
    calculateInterestRecencyScore(new Date(nowMs - 144 * 60 * 60 * 1000).toISOString(), {
      nowMs,
    }),
    25
  );
});

test("ranking existente continua priorizando o novo perfume masculino", async () => {
  const { buildCustomerInterestProfileRows } = await import(
    "../services/customerInterestProfile.service.js"
  );
  const { buildPersonalizedRanking } = await import(
    "../intelligence/recommendation.engine.js"
  );
  const nowMs = Date.parse("2026-08-24T12:00:00.000Z");
  const projection = buildCustomerInterestProfileRows(
    [
      event({ type: "product_detail_view", createdAt: "2026-08-24T11:56:00.000Z" }),
      event({ type: "product_add_confirmed", createdAt: "2026-08-24T11:58:00.000Z" }),
    ],
    {
      customerId: "11111111-1111-4111-8111-111111111111",
      nowMs,
      learningStartAt: "2026-08-01T00:00:00.000Z",
    }
  );
  const ranking = buildPersonalizedRanking({
    profile: projection.intent,
    limit: 3,
    products: [
      {
        id: "new-male",
        name: "Novo Perfume Masculino",
        sku: "NOVO-M",
        category: "perfume masculino",
        price: 249.9,
        stock_quantity: 10,
        status: "active",
      },
      {
        id: "skin",
        name: "Sérum Facial",
        sku: "SKIN-1",
        category: "Cuidados com a Pele",
        price: 99.9,
        stock_quantity: 10,
        status: "active",
      },
    ],
  });

  assert.equal(ranking.version, "recommendation-v2.2-active");
  assert.equal(ranking.recommendations[0].id, "new-male");
  assert.ok(ranking.recommendations[0].reasons.includes("categoria_preferida"));
});

test("e-mail explica a novidade sem expor score ou histórico", async () => {
  const { buildProductInterestEmail } = await import(
    "../services/productInterestNotification.service.js"
  );
  const email = buildProductInterestEmail({
    customer: { full_name: "João da Silva" },
    product: {
      name: "Perfume Masculino Novo",
      category: "Perfumes Masculinos",
      price: 199.9,
      image_url: "https://cdn.example.com/produto.webp",
    },
    productUrl: "https://loja.example.com/detalhe-produto.html?id=NOVO",
    unsubscribeUrl: "https://api.example.com/unsubscribe?token=abc",
    brandName: "levra_perfume",
    brandLogoUrl: "/assets/images/brand/store/icon-192.png",
    storefrontUrl: "https://loja.example.com",
  });

  assert.equal(email.subject, "Perfume Masculino Novo chegou na levra_perfume");
  assert.match(email.html, /Perfume Masculino Novo acabou de chegar/i);
  assert.match(
    email.html,
    /https:\/\/loja\.example\.com\/assets\/images\/brand\/store\/icon-192\.png/
  );
  assert.match(email.html, /https:\/\/cdn\.example\.com\/produto\.webp/);
  assert.match(email.html, /categoria que você acompanha/i);
  assert.match(email.html, /Cancelar novidades por e-mail/i);
  assert.doesNotMatch(email.html, /OZONTECK/i);
  assert.doesNotMatch(email.html, /match_score|category_score|histórico de navegação/i);

  const discoveryEmail = buildProductInterestEmail({
    customer: { full_name: "Cliente Descoberta" },
    product: {
      name: "Perfume Masculino Novo",
      category: "Perfumes Masculinos",
      price: 199.9,
    },
    productUrl: "https://loja.example.com/produto/novo",
    unsubscribeUrl: "https://api.example.com/unsubscribe?token=seguro",
    brandName: "levra_perfume",
    storefrontUrl: "https://loja.example.com",
    selectionMode: "discovery",
  });
  assert.match(discoveryEmail.html, /ainda estamos conhecendo suas preferências/i);
  assert.match(discoveryEmail.text, /sugestão de descoberta/i);
  assert.doesNotMatch(discoveryEmail.html, /categoria que você acompanha/i);
});

test("push mostra somente a novidade e abre o produto", async () => {
  const {
    buildProductInterestPushPayload,
    saveCustomerMarketingPushSubscription,
  } = await import(
    "../services/customerMarketingPush.service.js"
  );
  const payload = buildProductInterestPushPayload({
    product: {
      id: "product-1",
      name: "Perfume Masculino Novo",
      category: "Perfumes Masculinos",
      image_url: "https://cdn.example.com/produto.webp",
    },
    productUrl: "https://loja.example.com/detalhe-produto.html?id=NOVO",
    campaignId: "campaign-1",
    brandName: "levra_perfume",
    storefrontUrl: "https://loja.example.com",
  });

  assert.equal(payload.title, "Perfume Masculino Novo");
  assert.match(payload.body, /Perfumes Masculinos/i);
  assert.match(payload.body, /levra_perfume/i);
  assert.equal(payload.url, "https://loja.example.com/detalhe-produto.html?id=NOVO");
  assert.equal(payload.image, "https://cdn.example.com/produto.webp");
  assert.equal(
    payload.icon,
    "https://loja.example.com/assets/images/brand/store/icon-192.png"
  );
  assert.equal(payload.badge, payload.icon);
  assert.equal(payload.data.type, "product_interest");
  assert.equal(payload.data.brand, "levra_perfume");
  assert.doesNotMatch(JSON.stringify(payload), /OZONTECK/i);
  assert.doesNotMatch(JSON.stringify(payload), /match_score|category_score|histórico/i);

  await assert.rejects(
    saveCustomerMarketingPushSubscription(
      {
        customerId: "11111111-1111-4111-8111-111111111111",
        subscription: {
          endpoint: "https://example.com/falso",
          keys: { p256dh: "A".repeat(50), auth: "B".repeat(20) },
        },
      },
      {
        client: new Proxy(
          {},
          {
            get() {
              assert.fail("endpoint não confiável não deve consultar o banco");
            },
          }
        ),
      }
    ),
    (error) => error?.code === "invalid_web_push_endpoint"
  );
});

test("URL padrão da novidade abre a página real de detalhe da loja", async () => {
  const {
    buildProductUrl,
    getProductInterestNotificationConfig,
  } = await import("../services/productInterestNotification.service.js");
  const config = getProductInterestNotificationConfig({
    storefrontUrl: "https://loja.example.com",
    productUrlTemplate: "",
  });

  assert.equal(
    buildProductUrl({ id: "produto-1", sku: "VIP Girl" }, config),
    "https://loja.example.com/pages-html/loja/detalhe-produto.html?id=VIP%20Girl"
  );
});

test("consentimento Push explícito remove apenas a supressão Web Push", async () => {
  const { saveCustomerMarketingPushSubscription } = await import(
    "../services/customerMarketingPush.service.js"
  );
  const customerId = "11111111-1111-4111-8111-111111111111";
  const calls = [];

  function builder(table) {
    return {
      operation: "select",
      payload: null,
      delete() {
        this.operation = "delete";
        calls.push({ operation: "delete", table });
        return this;
      },
      upsert(payload) {
        this.operation = "upsert";
        this.payload = payload;
        calls.push({ operation: "upsert", table, payload });
        return this;
      },
      select() {
        return this;
      },
      eq(column, value) {
        calls.push({ operation: this.operation, table, column, value });
        return this;
      },
      single() {
        return Promise.resolve({
          data: {
            id: "22222222-2222-4222-8222-222222222222",
            customer_id: customerId,
            is_active: this.payload?.is_active === true,
            consented_at: this.payload?.consented_at,
            last_seen_at: this.payload?.last_seen_at,
          },
          error: null,
        });
      },
      maybeSingle() {
        return Promise.resolve({ data: null, error: null });
      },
      then(resolve, reject) {
        return Promise.resolve({ data: null, error: null }).then(resolve, reject);
      },
    };
  }

  const result = await saveCustomerMarketingPushSubscription(
    {
      customerId,
      marketingConsent: true,
      subscription: {
        endpoint: "https://fcm.googleapis.com/fcm/send/test-consent",
        keys: { p256dh: "A".repeat(50), auth: "B".repeat(20) },
      },
    },
    { client: { from: builder } }
  );

  assert.equal(result.is_active, true);
  assert.ok(
    calls.some(
      (call) =>
        call.operation === "delete" &&
        call.table === "customer_marketing_suppressions"
    )
  );
  assert.ok(
    calls.some(
      (call) =>
        call.operation === "delete" &&
        call.column === "channel" &&
        call.value === "web_push"
    )
  );
  assert.ok(
    calls.some(
      (call) =>
        call.operation === "upsert" &&
        call.table === "customer_marketing_push_subscriptions" &&
        call.payload?.is_active === true
    )
  );
});

test("transporte Web Push usa VAPID isolado e atualiza a inscrição", async () => {
  const { sendCustomerMarketingPush } = await import(
    "../services/customerMarketingPush.service.js"
  );
  const updates = [];
  let captured = null;

  function builder(operation = "select") {
    return {
      operation,
      select() {
        this.operation = "select";
        return this;
      },
      update(payload) {
        this.operation = "update";
        updates.push(payload);
        return this;
      },
      eq() {
        return this;
      },
      order() {
        return this;
      },
      limit() {
        return this;
      },
      then(resolve, reject) {
        const result =
          this.operation === "select"
            ? {
                data: [
                  {
                    id: "subscription-1",
                    endpoint: "https://fcm.googleapis.com/fcm/send/teste",
                    p256dh: "A".repeat(50),
                    auth: "B".repeat(20),
                    fail_count: 0,
                  },
                ],
                error: null,
              }
            : { data: null, error: null };
        return Promise.resolve(result).then(resolve, reject);
      },
    };
  }

  const result = await sendCustomerMarketingPush(
    {
      customerId: "11111111-1111-4111-8111-111111111111",
      product: {
        id: "product-1",
        name: "Perfume Masculino Novo",
        category: "Perfumes Masculinos",
      },
      productUrl: "https://loja.example.com/detalhe-produto.html?id=NOVO",
      campaignId: "campaign-1",
    },
    {
      client: { from: () => builder() },
      sender: async (subscription, payload, options) => {
        captured = { subscription, payload: JSON.parse(payload), options };
        return { statusCode: 201 };
      },
    }
  );

  assert.equal(result.success, true);
  assert.equal(result.sentCount, 1);
  assert.equal(captured.subscription.endpoint, "https://fcm.googleapis.com/fcm/send/teste");
  assert.equal(captured.payload.data.type, "product_interest");
  assert.match(captured.options.vapidDetails.subject, /^mailto:.+@.+$/);
  assert.ok(updates.some((payload) => payload.fail_count === 0 && payload.last_sent_at));
});

test("token de descadastro identifica apenas cliente, finalidade e canal", async () => {
  const {
    createProductInterestUnsubscribeToken,
    verifyProductInterestUnsubscribeToken,
  } = await import("../services/productInterestNotification.service.js");
  const customerId = "11111111-1111-4111-8111-111111111111";
  const token = createProductInterestUnsubscribeToken(customerId, {
    unsubscribeTokenDays: 30,
  });
  const decoded = verifyProductInterestUnsubscribeToken(token);

  assert.equal(decoded.customer_id, customerId);
  assert.equal(decoded.type, "product_interest_unsubscribe");
  assert.equal(decoded.channel, "email");
  assert.equal(decoded.email, undefined);
});

test("migration protege concorrência, acesso público e deduplicação", () => {
  const sql = read("sql/20260824-product-interest-notifications.sql");
  const rollback = read("sql/20260824-product-interest-notifications-rollback.sql");
  const pushSql = read("sql/20260824-product-interest-web-push.sql");
  const pushRollback = read("sql/20260824-product-interest-web-push-rollback.sql");

  assert.match(sql, /for update skip locked/i);
  assert.match(sql, /pg_advisory_xact_lock/i);
  assert.match(sql, /reserve_product_interest_delivery/i);
  assert.match(sql, /security invoker/i);
  assert.match(
    sql,
    /revoke execute on function public\.claim_product_notification_jobs[\s\S]*from public, anon, authenticated/i
  );
  assert.match(sql, /unique \(campaign_id, customer_id, channel\)/i);
  assert.match(sql, /unique \(product_id, campaign_type\)/i);
  assert.match(sql, /unique \(visitor_id\)/i);
  assert.match(sql, /enable row level security/gi);
  assert.match(sql, /when others then[\s\S]*raise warning/i);
  assert.match(sql, /after insert or update of status, stock_quantity on public\.products/i);
  assert.doesNotMatch(sql, /update of price|update of image_url/i);
  assert.match(rollback, /drop trigger if exists products_enqueue_new_interest_campaign/i);
  assert.match(rollback, /drop function if exists public\.reserve_product_interest_delivery/i);
  assert.match(rollback, /drop table if exists public\.customer_visitor_links/i);
  assert.match(pushSql, /customer_marketing_push_subscriptions/i);
  assert.match(pushSql, /check \(channel in \('email', 'web_push'\)\)/i);
  assert.match(pushSql, /reserve_product_interest_channel_delivery/i);
  assert.match(pushSql, /pg_advisory_xact_lock/i);
  assert.match(pushSql, /enable row level security/i);
  assert.match(
    pushSql,
    /revoke all on table public\.customer_marketing_push_subscriptions[\s\S]*from public, anon, authenticated/i
  );
  assert.match(
    pushSql,
    /revoke execute on function public\.reserve_product_interest_channel_delivery[\s\S]*from public, anon, authenticated/i
  );
  assert.match(pushRollback, /drop table if exists public\.customer_marketing_push_subscriptions/i);
});

test("integração da loja vincula somente visitor e session usando JWT da própria conta", () => {
  const tracking = fs.readFileSync(
    path.join(workspaceRoot, "ozonteck-loja/frontend/assets/js/tracking.js"),
    "utf8"
  );
  const login = fs.readFileSync(
    path.join(workspaceRoot, "ozonteck-loja/frontend/assets/js/pages/login.js"),
    "utf8"
  );

  assert.match(tracking, /customer\/marketing\/identity/);
  assert.match(tracking, /Authorization: `Bearer \$\{token\}`/);
  assert.match(tracking, /visitor_id: visitorId/);
  assert.match(tracking, /session_id: sessionId/);
  assert.doesNotMatch(tracking, /customer_id:\s*customer/i);
  assert.match(login, /oz:customer-authenticated/);
  assert.match(tracking, /customer\/marketing\/push\/subscription/);
  assert.match(tracking, /navigator\.serviceWorker\.register\("\/service-worker\.js"\)/);
  assert.match(tracking, /window\.Notification\.permission !== "granted"/);
  assert.match(tracking, /subscription: subscription\.toJSON\(\)/);
  assert.match(tracking, /requestBody\.marketing_consent = true/);
  assert.match(tracking, /marketingConsent: true/);
  assert.match(tracking, /visitor_id: visitorId/);
  assert.match(tracking, /session_id: sessionId/);
  assert.match(tracking, /if \(token\) headers\.Authorization/);
  assert.match(tracking, /getMarketingPushConsentMarker/);
  const pushSyncSource = tracking.slice(
    tracking.indexOf("async function syncCustomerMarketingPushSubscription"),
    tracking.indexOf("async function requestCustomerMarketingPushPermission")
  );
  assert.doesNotMatch(pushSyncSource, /if \(!token\) return false/);
  assert.doesNotMatch(
    pushSyncSource,
    /sessionStorage\.getItem\(CUSTOMER_PUSH_SYNC_KEY\)[\s\S]{0,120}return true/
  );
  assert.doesNotMatch(tracking, /customer_id:\s*.*subscription/i);
});

test("catálogo oferece Push somente por ação explícita e permite adiar", () => {
  const catalogFeatures = fs.readFileSync(
    path.join(
      workspaceRoot,
      "ozonteck-loja/frontend/assets/js/core/catalogo-lazy-features.js"
    ),
    "utf8"
  );

  assert.match(catalogFeatures, /Receba novidades de produtos/);
  assert.match(catalogFeatures, /Ativar notificações/);
  assert.match(catalogFeatures, /requestCustomerMarketingPushPermission/);
  assert.match(catalogFeatures, /enableButton\.addEventListener\("click"/);
  assert.match(catalogFeatures, /pushDismissCooldownMs = 7 \* 24 \* 60 \* 60 \* 1000/);
  assert.match(catalogFeatures, /window\.Notification\.permission === "denied"/);
  assert.match(catalogFeatures, /getVisitorPushConsentMarker/);
  assert.match(catalogFeatures, /localStorage\.removeItem\(pushConsentKey\)/);
  assert.doesNotMatch(catalogFeatures, /if \(!token\) return false/);
  assert.doesNotMatch(catalogFeatures, /Notification\.requestPermission\(/);
});

test("rota de inscrição push aceita visitante verificado e nunca confia em customer_id do corpo", () => {
  const routes = read("routes/customerMarketingPreferences.routes.js");

  assert.match(routes, /router\.post\("\/push\/subscription", optionalCustomerAuth/);
  assert.match(routes, /verifyVisitorSession\(\{ visitorId, sessionId \}\)/);
  assert.match(routes, /if \(!req\.customerAuth && !marketingConsent\)/);
  assert.match(
    routes,
    /req\.customer\?\.newsletter_opt_in !== true &&\s*!marketingConsent/
  );
  assert.match(routes, /req\.body\?\.marketing_consent === true/);
  assert.match(routes, /customerId: req\.customerAuth\?\.id \|\| null/);
  assert.match(routes, /visitorId,/);
  assert.match(routes, /sessionId,/);
  assert.match(routes, /subscription: req\.body\?\.subscription/);
  assert.match(routes, /marketingConsent,/);
  assert.doesNotMatch(routes, /customerId: req\.body/);
});

test("configuração permanece fechada e em simulação por padrão", async () => {
  const { getProductInterestNotificationConfig } = await import(
    "../services/productInterestNotification.service.js"
  );
  const previousEnabled = process.env.PRODUCT_INTEREST_NOTIFICATIONS_ENABLED;
  const previousDryRun = process.env.PRODUCT_INTEREST_NOTIFICATIONS_DRY_RUN;
  const previousConsent = process.env.PRODUCT_INTEREST_CONSENT_CONFIRMED;
  const previousBrandName = process.env.PRODUCT_INTEREST_BRAND_NAME;
  const previousBrandIcon = process.env.PRODUCT_INTEREST_BRAND_ICON_URL;
  const previousBrandBadge = process.env.PRODUCT_INTEREST_BRAND_BADGE_URL;
  const previousDiscovery = process.env.PRODUCT_INTEREST_DISCOVERY_ENABLED;
  const previousDiscoveryShare =
    process.env.PRODUCT_INTEREST_DISCOVERY_SHARE_PERCENT;
  const previousDiscoveryLimit =
    process.env.PRODUCT_INTEREST_DISCOVERY_CANDIDATE_LIMIT;

  delete process.env.PRODUCT_INTEREST_NOTIFICATIONS_ENABLED;
  delete process.env.PRODUCT_INTEREST_NOTIFICATIONS_DRY_RUN;
  delete process.env.PRODUCT_INTEREST_CONSENT_CONFIRMED;
  delete process.env.PRODUCT_INTEREST_BRAND_NAME;
  delete process.env.PRODUCT_INTEREST_BRAND_ICON_URL;
  delete process.env.PRODUCT_INTEREST_BRAND_BADGE_URL;
  delete process.env.PRODUCT_INTEREST_DISCOVERY_ENABLED;
  delete process.env.PRODUCT_INTEREST_DISCOVERY_SHARE_PERCENT;
  delete process.env.PRODUCT_INTEREST_DISCOVERY_CANDIDATE_LIMIT;
  const config = getProductInterestNotificationConfig({
    storefrontUrl: "https://loja.example.com",
  });

  assert.equal(config.enabled, false);
  assert.equal(config.dryRun, true);
  assert.equal(config.consentConfirmed, false);
  assert.equal(config.discoveryEnabled, true);
  assert.equal(config.discoverySharePercent, 20);
  assert.equal(config.discoveryCandidateLimit, 250);
  assert.equal(config.brandName, "levra_perfume");
  assert.equal(
    config.brandIconUrl,
    "https://loja.example.com/assets/images/brand/store/icon-192.png"
  );
  assert.equal(config.brandBadgeUrl, config.brandIconUrl);

  if (previousEnabled === undefined) delete process.env.PRODUCT_INTEREST_NOTIFICATIONS_ENABLED;
  else process.env.PRODUCT_INTEREST_NOTIFICATIONS_ENABLED = previousEnabled;
  if (previousDryRun === undefined) delete process.env.PRODUCT_INTEREST_NOTIFICATIONS_DRY_RUN;
  else process.env.PRODUCT_INTEREST_NOTIFICATIONS_DRY_RUN = previousDryRun;
  if (previousConsent === undefined) delete process.env.PRODUCT_INTEREST_CONSENT_CONFIRMED;
  else process.env.PRODUCT_INTEREST_CONSENT_CONFIRMED = previousConsent;
  if (previousBrandName === undefined) delete process.env.PRODUCT_INTEREST_BRAND_NAME;
  else process.env.PRODUCT_INTEREST_BRAND_NAME = previousBrandName;
  if (previousBrandIcon === undefined) delete process.env.PRODUCT_INTEREST_BRAND_ICON_URL;
  else process.env.PRODUCT_INTEREST_BRAND_ICON_URL = previousBrandIcon;
  if (previousBrandBadge === undefined) delete process.env.PRODUCT_INTEREST_BRAND_BADGE_URL;
  else process.env.PRODUCT_INTEREST_BRAND_BADGE_URL = previousBrandBadge;
  if (previousDiscovery === undefined) delete process.env.PRODUCT_INTEREST_DISCOVERY_ENABLED;
  else process.env.PRODUCT_INTEREST_DISCOVERY_ENABLED = previousDiscovery;
  if (previousDiscoveryShare === undefined) {
    delete process.env.PRODUCT_INTEREST_DISCOVERY_SHARE_PERCENT;
  } else {
    process.env.PRODUCT_INTEREST_DISCOVERY_SHARE_PERCENT = previousDiscoveryShare;
  }
  if (previousDiscoveryLimit === undefined) {
    delete process.env.PRODUCT_INTEREST_DISCOVERY_CANDIDATE_LIMIT;
  } else {
    process.env.PRODUCT_INTEREST_DISCOVERY_CANDIDATE_LIMIT = previousDiscoveryLimit;
  }
});

test("worker desativado não consulta banco nem reivindica jobs", async () => {
  const { runProductInterestNotificationSweep } = await import(
    "../services/productInterestNotification.service.js"
  );
  const forbiddenClient = new Proxy(
    {},
    {
      get() {
        assert.fail("o banco não deve ser acessado com a feature desativada");
      },
    }
  );

  const result = await runProductInterestNotificationSweep(
    { trigger: "test", config: { enabled: false } },
    { client: forbiddenClient }
  );
  assert.deepEqual(result, {
    skipped: true,
    reason: "feature_disabled",
    trigger: "test",
  });
});

test("dry-run reserva e-mail e Web Push separadamente para o mesmo interesse", async () => {
  const { runProductInterestNotificationSweep } = await import(
    "../services/productInterestNotification.service.js"
  );
  const customerId = "11111111-1111-4111-8111-111111111111";
  const campaignId = "22222222-2222-4222-8222-222222222222";
  const nowMs = Date.parse("2026-08-24T12:00:00.000Z");
  const rpcCalls = [];
  let customerNewsletterOptIn = true;

  function resultFor(table, operation) {
    if (operation === "update") return { data: null, error: null };
    if (table === "customer_visitor_links") return { data: [], error: null };
    if (table === "product_notification_campaigns") {
      return {
        data: {
          id: campaignId,
          product_id: "33333333-3333-4333-8333-333333333333",
          campaign_type: "new_product_interest",
          status: "queued",
        },
        error: null,
      };
    }
    if (table === "products") {
      return {
        data: {
          id: "33333333-3333-4333-8333-333333333333",
          name: "Perfume Masculino Novo",
          sku: "NOVO-M",
          category: "Perfumes Masculinos",
          price: 199.9,
          status: "active",
          stock_quantity: 10,
          image_url: "https://cdn.example.com/produto.webp",
        },
        error: null,
      };
    }
    if (table === "customer_interest_profiles") {
      return {
        data: [
          {
            customer_id: customerId,
            category_key: "perfumes_masculinos",
            category_score: 95,
            confidence: 90,
            qualifying_signal_count: 2,
            last_signal_at: new Date(nowMs - 60_000).toISOString(),
            profile_version: "intent-v1.2-test",
          },
        ],
        error: null,
      };
    }
    if (table === "customers") {
      return {
        data: [
          {
            id: customerId,
            full_name: "Cliente Teste",
            email: "cliente@example.com",
            newsletter_opt_in: customerNewsletterOptIn,
            account_enabled: true,
          },
        ],
        error: null,
      };
    }
    if (table === "customer_marketing_suppressions") return { data: [], error: null };
    if (table === "customer_notification_deliveries") return { data: [], error: null };
    if (table === "customer_marketing_push_subscriptions") {
      return { data: [{ customer_id: customerId }], error: null };
    }
    return { data: [], error: null };
  }

  function queryBuilder(table) {
    const builder = {
      operation: "select",
      select() {
        this.operation = "select";
        return this;
      },
      update() {
        this.operation = "update";
        return this;
      },
      eq() {
        return this;
      },
      in() {
        return this;
      },
      gte() {
        return this;
      },
      or() {
        return this;
      },
      order() {
        return this;
      },
      limit() {
        return this;
      },
      maybeSingle() {
        return Promise.resolve(resultFor(table, this.operation));
      },
      then(resolve, reject) {
        return Promise.resolve(resultFor(table, this.operation)).then(resolve, reject);
      },
    };
    return builder;
  }

  const fakeClient = {
    from(table) {
      return queryBuilder(table);
    },
    async rpc(name, args) {
      rpcCalls.push({ name, args });
      if (name === "claim_product_notification_jobs") {
        return {
          data: [{ id: 7, campaign_id: campaignId, attempts: 1, max_attempts: 3 }],
          error: null,
        };
      }
      if (name === "reserve_product_interest_channel_delivery") {
        return { data: `delivery-${args.p_channel}`, error: null };
      }
      if (name === "reserve_product_interest_recipient_delivery") {
        return { data: "delivery-web_push", error: null };
      }
      return { data: null, error: null };
    },
  };

  const result = await runProductInterestNotificationSweep(
    {
      trigger: "test_email_and_push",
      config: {
        enabled: true,
        dryRun: true,
        consentConfirmed: false,
        emailEnabled: true,
        webPushEnabled: true,
        recipientLimit: 1,
        jobLimit: 1,
        profileRefreshLimit: 1,
      },
    },
    { client: fakeClient, nowMs }
  );

  const reservedChannels = rpcCalls
    .filter((call) =>
      [
        "reserve_product_interest_channel_delivery",
        "reserve_product_interest_recipient_delivery",
      ].includes(call.name)
    )
    .map((call) => call.args.p_channel)
    .sort();

  assert.deepEqual(reservedChannels, ["email", "web_push"]);
  assert.equal(result.jobs[0].selected, 2);
  assert.equal(result.jobs[0].simulated, 2);
  assert.equal(result.jobs[0].channels.email.simulated, 1);
  assert.equal(result.jobs[0].channels.web_push.simulated, 1);

  rpcCalls.length = 0;
  let emailCalls = 0;
  let pushCalls = 0;
  let capturedEmail = null;
  let capturedPush = null;
  const liveResult = await runProductInterestNotificationSweep(
    {
      trigger: "test_live_email_and_push",
      config: {
        enabled: true,
        dryRun: false,
        consentConfirmed: true,
        emailEnabled: true,
        webPushEnabled: true,
        recipientLimit: 1,
        jobLimit: 1,
        profileRefreshLimit: 1,
        apiPublicUrl: "https://api.example.com",
        storefrontUrl: "https://loja.example.com",
        brandName: "levra_perfume",
        brandIconUrl:
          "https://loja.example.com/assets/images/brand/store/icon-192.png",
        brandBadgeUrl:
          "https://loja.example.com/assets/images/brand/store/icon-192.png",
      },
    },
    {
      client: fakeClient,
      nowMs,
      mailer: async (message) => {
        emailCalls += 1;
        capturedEmail = message;
        return { success: true, messageId: "email-test" };
      },
      pushMailer: async (message) => {
        pushCalls += 1;
        capturedPush = message;
        return { success: true, sentCount: 1, failedCount: 0 };
      },
    }
  );

  assert.equal(emailCalls, 1);
  assert.equal(pushCalls, 1);
  assert.equal(capturedEmail.fromName, "levra_perfume");
  assert.match(capturedEmail.subject, /Perfume Masculino Novo/);
  assert.equal(
    capturedEmail.headers["List-ID"],
    "Novidades levra_perfume <novidades.levra-perfume>"
  );
  assert.equal(capturedPush.brandName, "levra_perfume");
  assert.equal(
    capturedPush.brandIconUrl,
    "https://loja.example.com/assets/images/brand/store/icon-192.png"
  );
  assert.equal(capturedPush.brandBadgeUrl, capturedPush.brandIconUrl);
  assert.equal(liveResult.jobs[0].sent, 2);
  assert.equal(liveResult.jobs[0].channels.email.sent, 1);
  assert.equal(liveResult.jobs[0].channels.web_push.sent, 1);

  rpcCalls.length = 0;
  customerNewsletterOptIn = false;
  const optedOutResult = await runProductInterestNotificationSweep(
    {
      trigger: "test_customer_without_marketing_opt_in",
      config: {
        enabled: true,
        dryRun: true,
        consentConfirmed: false,
        emailEnabled: true,
        webPushEnabled: true,
        recipientLimit: 1,
        jobLimit: 1,
        profileRefreshLimit: 1,
      },
    },
    { client: fakeClient, nowMs }
  );

  const optedOutChannels = rpcCalls
    .filter((call) =>
      [
        "reserve_product_interest_channel_delivery",
        "reserve_product_interest_recipient_delivery",
      ].includes(call.name)
    )
    .map((call) => call.args.p_channel);
  assert.deepEqual(optedOutChannels, ["web_push"]);
  assert.equal(optedOutResult.jobs[0].selected, 1);
  assert.equal(optedOutResult.jobs[0].channels.email.selected, 0);
  assert.equal(optedOutResult.jobs[0].channels.web_push.selected, 1);
});

test("descoberta notifica sem perfil e para quando um interesse é aprendido", async () => {
  const { runProductInterestNotificationSweep } = await import(
    "../services/productInterestNotification.service.js"
  );
  const customerId = "11111111-1111-4111-8111-111111111111";
  const campaignId = "22222222-2222-4222-8222-222222222222";
  const productId = "33333333-3333-4333-8333-333333333333";
  const nowMs = Date.parse("2026-08-24T12:00:00.000Z");
  const rpcCalls = [];
  let learnedAnotherCategory = false;

  function resultFor(table, builder) {
    if (builder.operation === "update") return { data: null, error: null };
    if (table === "customer_visitor_links") return { data: [], error: null };
    if (table === "product_notification_campaigns") {
      return {
        data: {
          id: campaignId,
          product_id: productId,
          campaign_type: "new_product_interest",
          status: "queued",
        },
        error: null,
      };
    }
    if (table === "products") {
      return {
        data: {
          id: productId,
          name: "Descoberta Masculina",
          sku: "DESCOBERTA-M",
          category: "Perfumes Masculinos",
          price: 99.9,
          status: "active",
          stock_quantity: 8,
          image_url: "https://cdn.example.com/descoberta.webp",
        },
        error: null,
      };
    }
    if (table === "customer_interest_profiles") {
      const targetedQuery = builder.eqFilters.some(
        ([column]) => column === "category_key"
      );
      if (targetedQuery || !learnedAnotherCategory) return { data: [], error: null };
      return {
        data: [
          {
            customer_id: customerId,
            category_score: 92,
            confidence: 88,
            qualifying_signal_count: 2,
            last_signal_at: new Date(nowMs - 60_000).toISOString(),
          },
        ],
        error: null,
      };
    }
    if (table === "customers") {
      if (builder.selectedColumns === "id") {
        return { data: [{ id: customerId }], error: null };
      }
      return {
        data: [
          {
            id: customerId,
            full_name: "Cliente Descoberta",
            email: "cliente@example.com",
            newsletter_opt_in: false,
            account_enabled: true,
          },
        ],
        error: null,
      };
    }
    if (table === "customer_marketing_push_subscriptions") {
      return { data: [{ customer_id: customerId }], error: null };
    }
    if (table === "customer_marketing_suppressions") return { data: [], error: null };
    if (table === "customer_notification_deliveries") return { data: [], error: null };
    return { data: [], error: null };
  }

  function queryBuilder(table) {
    return {
      operation: "select",
      selectedColumns: "",
      eqFilters: [],
      select(columns) {
        this.operation = "select";
        this.selectedColumns = columns;
        return this;
      },
      update() {
        this.operation = "update";
        return this;
      },
      eq(column, value) {
        this.eqFilters.push([column, value]);
        return this;
      },
      in() {
        return this;
      },
      gte() {
        return this;
      },
      or() {
        return this;
      },
      order() {
        return this;
      },
      limit() {
        return this;
      },
      maybeSingle() {
        return Promise.resolve(resultFor(table, this));
      },
      then(resolve, reject) {
        return Promise.resolve(resultFor(table, this)).then(resolve, reject);
      },
    };
  }

  const fakeClient = {
    from(table) {
      return queryBuilder(table);
    },
    async rpc(name, args) {
      rpcCalls.push({ name, args });
      if (name === "claim_product_notification_jobs") {
        return {
          data: [{ id: 9, campaign_id: campaignId, attempts: 1, max_attempts: 3 }],
          error: null,
        };
      }
      if (name === "reserve_product_interest_channel_delivery") {
        return { data: "delivery-discovery", error: null };
      }
      if (name === "reserve_product_interest_recipient_delivery") {
        return { data: "delivery-discovery", error: null };
      }
      return { data: null, error: null };
    },
  };

  const discoveryResult = await runProductInterestNotificationSweep(
    {
      trigger: "test_discovery_without_profile",
      config: {
        enabled: true,
        dryRun: true,
        consentConfirmed: false,
        emailEnabled: false,
        webPushEnabled: true,
        discoveryEnabled: true,
        discoverySharePercent: 20,
        discoveryCandidateLimit: 25,
        recipientLimit: 1,
        jobLimit: 1,
        profileRefreshLimit: 1,
      },
    },
    { client: fakeClient, nowMs }
  );

  const discoveryReservation = rpcCalls.find(
    (call) => call.name === "reserve_product_interest_recipient_delivery"
  );
  assert.equal(discoveryResult.jobs[0].discovery_candidates, 1);
  assert.equal(discoveryResult.jobs[0].discovery_recipients, 1);
  assert.equal(discoveryResult.jobs[0].selected, 1);
  assert.equal(discoveryResult.jobs[0].simulated, 1);
  assert.equal(discoveryReservation.args.p_channel, "web_push");
  assert.equal(discoveryReservation.args.p_match_score, 0);
  assert.equal(discoveryReservation.args.p_metadata.selection_mode, "discovery");

  rpcCalls.length = 0;
  learnedAnotherCategory = true;
  const learnedResult = await runProductInterestNotificationSweep(
    {
      trigger: "test_discovery_stops_after_learning",
      config: {
        enabled: true,
        dryRun: true,
        consentConfirmed: false,
        emailEnabled: false,
        webPushEnabled: true,
        discoveryEnabled: true,
        discoveryCandidateLimit: 25,
        recipientLimit: 1,
        jobLimit: 1,
        profileRefreshLimit: 1,
      },
    },
    { client: fakeClient, nowMs }
  );

  assert.equal(
    rpcCalls.filter(
      (call) => call.name === "reserve_product_interest_recipient_delivery"
    ).length,
    0
  );
  assert.equal(learnedResult.jobs[0].reason, "no_eligible_audience");
  assert.equal(learnedResult.jobs[0].selected, 0);
});

test("perfil pseudônimo usa o mesmo aprendizado sem criar conta de cliente", async () => {
  const { buildVisitorInterestProfileRows } = await import(
    "../services/customerInterestProfile.service.js"
  );
  const nowMs = Date.parse("2026-08-26T18:00:00.000Z");
  const projection = buildVisitorInterestProfileRows(
    [
      event({ type: "product_detail_view", createdAt: new Date(nowMs - 60_000).toISOString() }),
      event({ type: "add_to_cart", createdAt: new Date(nowMs - 30_000).toISOString() }),
    ],
    { visitorId: "visitor-anonimo-1", nowMs, learningStartAt: "2026-01-01T00:00:00.000Z" }
  );

  assert.equal(projection.rows[0].visitor_id, "visitor-anonimo-1");
  assert.equal(projection.rows[0].category_key, "perfumes_masculinos");
  assert.equal(projection.rows[0].customer_id, undefined);
  assert.ok(projection.rows[0].qualifying_signal_count >= 1);
});

test("inscrição anônima preserva o dono autenticado de um endpoint existente", async () => {
  const { saveCustomerMarketingPushSubscription } = await import(
    "../services/customerMarketingPush.service.js"
  );
  const customerId = "11111111-1111-4111-8111-111111111111";
  let savedPayload = null;

  function builder(table) {
    return {
      payload: null,
      select() {
        return this;
      },
      delete() {
        return this;
      },
      eq() {
        return this;
      },
      upsert(payload) {
        this.payload = payload;
        savedPayload = payload;
        return this;
      },
      maybeSingle() {
        if (table === "customer_marketing_push_subscriptions") {
          return Promise.resolve({
            data: {
              id: "22222222-2222-4222-8222-222222222222",
              customer_id: customerId,
              visitor_id: "visitor-antigo",
              p256dh: "A".repeat(50),
              auth: "B".repeat(20),
            },
            error: null,
          });
        }
        return Promise.resolve({ data: null, error: null });
      },
      single() {
        return Promise.resolve({
          data: {
            id: "22222222-2222-4222-8222-222222222222",
            ...this.payload,
          },
          error: null,
        });
      },
      then(resolve, reject) {
        return Promise.resolve({ data: null, error: null }).then(resolve, reject);
      },
    };
  }

  await saveCustomerMarketingPushSubscription(
    {
      visitorId: "visitor-novo",
      sessionId: "session-nova",
      marketingConsent: true,
      subscription: {
        endpoint: "https://fcm.googleapis.com/fcm/send/anonymous-owner-test",
        keys: { p256dh: "A".repeat(50), auth: "B".repeat(20) },
      },
    },
    { client: { from: builder } }
  );

  assert.equal(savedPayload.customer_id, customerId);
  assert.equal(savedPayload.visitor_id, "visitor-novo");
  assert.equal(savedPayload.last_session_id, "session-nova");
});

test("endpoint existente não pode ser assumido com chaves Push diferentes", async () => {
  const { saveCustomerMarketingPushSubscription } = await import(
    "../services/customerMarketingPush.service.js"
  );
  const client = {
    from() {
      return {
        select() { return this; },
        eq() { return this; },
        maybeSingle() {
          return Promise.resolve({
            data: {
              id: "22222222-2222-4222-8222-222222222222",
              customer_id: null,
              visitor_id: "visitor-original",
              p256dh: "C".repeat(50),
              auth: "D".repeat(20),
            },
            error: null,
          });
        },
      };
    },
  };

  await assert.rejects(
    saveCustomerMarketingPushSubscription(
      {
        visitorId: "visitor-atacante",
        sessionId: "session-atacante",
        marketingConsent: true,
        subscription: {
          endpoint: "https://fcm.googleapis.com/fcm/send/ownership-mismatch",
          keys: { p256dh: "A".repeat(50), auth: "B".repeat(20) },
        },
      },
      { client }
    ),
    (error) =>
      error?.statusCode === 409 &&
      error?.code === "web_push_subscription_ownership_mismatch"
  );
});

test("Web Push percorre toda a audiência e restringe categorias após aprendizado", async () => {
  const {
    getProductInterestNotificationConfig,
    processWebPushAudience,
  } = await import("../services/productInterestNotification.service.js");
  const nowMs = Date.parse("2026-08-26T18:00:00.000Z");
  const subscriptions = Array.from({ length: 12 }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    customer_id: null,
    visitor_id: `visitor-${String(index + 1).padStart(2, "0")}`,
    last_seen_at: new Date(nowMs - index * 1000).toISOString(),
    profile_refreshed_at: new Date(nowMs - 60_000).toISOString(),
  }));
  let learnedAnotherCategory = false;
  const reservations = [];

  function resultFor(table, builder) {
    if (builder.operation === "update") return { data: null, error: null };
    if (table === "customer_marketing_push_subscriptions") {
      const cursor = builder.gtFilters.find(([column]) => column === "id")?.[1] || "";
      return {
        data: subscriptions
          .filter((row) => !cursor || row.id > cursor)
          .slice(0, builder.limitValue || subscriptions.length),
        error: null,
      };
    }
    if (table === "visitor_interest_profiles") {
      if (!learnedAnotherCategory) return { data: [], error: null };
      const requested = new Set(builder.inFilters.find(([column]) => column === "visitor_id")?.[1] || []);
      return {
        data: subscriptions
          .filter((row) => requested.has(row.visitor_id))
          .map((row) => ({
            visitor_id: row.visitor_id,
            category_key: "perfumes_femininos",
            category_score: 90,
            confidence: 90,
            qualifying_signal_count: 2,
            last_signal_at: new Date(nowMs - 60_000).toISOString(),
            profile_version: "intent-test",
          })),
        error: null,
      };
    }
    return { data: [], error: null };
  }

  function queryBuilder(table) {
    return {
      operation: "select",
      gtFilters: [],
      inFilters: [],
      limitValue: 0,
      select() {
        this.operation = "select";
        return this;
      },
      update() {
        this.operation = "update";
        return this;
      },
      eq() {
        return this;
      },
      gte() {
        return this;
      },
      order() {
        return this;
      },
      gt(column, value) {
        this.gtFilters.push([column, value]);
        return this;
      },
      in(column, values) {
        this.inFilters.push([column, values]);
        return this;
      },
      limit(value) {
        this.limitValue = value;
        return this;
      },
      then(resolve, reject) {
        return Promise.resolve(resultFor(table, this)).then(resolve, reject);
      },
    };
  }

  const client = {
    from(table) {
      return queryBuilder(table);
    },
    async rpc(name, args) {
      assert.equal(name, "reserve_product_interest_recipient_delivery");
      reservations.push(args);
      return { data: `delivery-${reservations.length}`, error: null };
    },
  };
  const config = getProductInterestNotificationConfig({
    enabled: true,
    dryRun: true,
    emailEnabled: false,
    webPushEnabled: true,
    discoveryEnabled: true,
    recipientLimit: 1,
    pushAudiencePageSize: 10,
  });
  const context = {
    campaign: { id: "22222222-2222-4222-8222-222222222222" },
    product: {
      id: "33333333-3333-4333-8333-333333333333",
      name: "Perfume Masculino Novo",
      category: "Perfumes Masculinos",
    },
    categoryKey: "perfumes_masculinos",
    productUrl: "https://loja.example.com/pages-html/loja/detalhe-produto.html?id=produto",
    config,
    nowMs,
  };

  const discovery = await processWebPushAudience(context, {
    client,
    pushMailer: async () => assert.fail("dry-run não envia Push"),
  });
  assert.equal(discovery.selected, 12);
  assert.equal(discovery.discovery_recipients, 12);
  assert.equal(reservations.length, 12);
  assert.ok(reservations.every((item) => item.p_customer_id === null));
  assert.ok(reservations.every((item) => item.p_recipient_key.startsWith("visitor:")));

  learnedAnotherCategory = true;
  reservations.length = 0;
  const learned = await processWebPushAudience(context, {
    client,
    pushMailer: async () => assert.fail("categoria incompatível não envia Push"),
  });
  assert.equal(learned.targeted_candidates, 12);
  assert.equal(learned.selected, 0);
  assert.equal(reservations.length, 0);
});

test("migration anônima mantém RLS e deduplica por destinatário pseudônimo", () => {
  const sql = read("sql/20260826-anonymous-product-interest-push.sql");

  assert.match(sql, /alter column customer_id drop not null/i);
  assert.match(sql, /create table if not exists public\.visitor_interest_profiles/i);
  assert.match(sql, /alter table public\.visitor_interest_profiles enable row level security/i);
  assert.match(
    sql,
    /revoke all on table public\.visitor_interest_profiles from public, anon, authenticated/i
  );
  assert.match(sql, /unique \(campaign_id, recipient_key, channel\)/i);
  assert.match(sql, /pg_advisory_xact_lock/i);
  assert.match(sql, /reserve_product_interest_recipient_delivery/i);
  assert.match(sql, /customer_id is not null or visitor_id is not null/i);
});
