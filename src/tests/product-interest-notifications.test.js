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
const workspaceRoot = path.resolve(root, "../..");

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
  });

  assert.match(email.html, /categoria que você acompanha/i);
  assert.match(email.html, /Cancelar novidades por e-mail/i);
  assert.doesNotMatch(email.html, /match_score|category_score|histórico de navegação/i);
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
  });

  assert.match(payload.title, /Perfume Masculino Novo/i);
  assert.match(payload.body, /Perfumes Masculinos/i);
  assert.equal(payload.url, "https://loja.example.com/detalhe-produto.html?id=NOVO");
  assert.equal(payload.data.type, "product_interest");
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
  assert.doesNotMatch(tracking, /customer_id:\s*.*subscription/i);
});

test("rota de inscrição push deriva o cliente do JWT", () => {
  const routes = read("routes/customerMarketingPreferences.routes.js");

  assert.match(routes, /router\.post\("\/push\/subscription", requireCustomerAuth/);
  assert.match(routes, /req\.customer\?\.newsletter_opt_in !== true/);
  assert.match(routes, /customerId: req\.customerAuth\.id/);
  assert.match(routes, /subscription: req\.body\?\.subscription/);
  assert.doesNotMatch(routes, /customerId: req\.body/);
  assert.ok(
    routes.indexOf("req.customer?.newsletter_opt_in !== true") <
      routes.indexOf("const subscription = await saveCustomerMarketingPushSubscription"),
    "o opt-in deve ser validado antes de salvar a inscrição push"
  );
});

test("configuração permanece fechada e em simulação por padrão", async () => {
  const { getProductInterestNotificationConfig } = await import(
    "../services/productInterestNotification.service.js"
  );
  const previousEnabled = process.env.PRODUCT_INTEREST_NOTIFICATIONS_ENABLED;
  const previousDryRun = process.env.PRODUCT_INTEREST_NOTIFICATIONS_DRY_RUN;
  const previousConsent = process.env.PRODUCT_INTEREST_CONSENT_CONFIRMED;

  delete process.env.PRODUCT_INTEREST_NOTIFICATIONS_ENABLED;
  delete process.env.PRODUCT_INTEREST_NOTIFICATIONS_DRY_RUN;
  delete process.env.PRODUCT_INTEREST_CONSENT_CONFIRMED;
  const config = getProductInterestNotificationConfig();

  assert.equal(config.enabled, false);
  assert.equal(config.dryRun, true);
  assert.equal(config.consentConfirmed, false);

  if (previousEnabled === undefined) delete process.env.PRODUCT_INTEREST_NOTIFICATIONS_ENABLED;
  else process.env.PRODUCT_INTEREST_NOTIFICATIONS_ENABLED = previousEnabled;
  if (previousDryRun === undefined) delete process.env.PRODUCT_INTEREST_NOTIFICATIONS_DRY_RUN;
  else process.env.PRODUCT_INTEREST_NOTIFICATIONS_DRY_RUN = previousDryRun;
  if (previousConsent === undefined) delete process.env.PRODUCT_INTEREST_CONSENT_CONFIRMED;
  else process.env.PRODUCT_INTEREST_CONSENT_CONFIRMED = previousConsent;
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
    .filter((call) => call.name === "reserve_product_interest_channel_delivery")
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
      },
    },
    {
      client: fakeClient,
      nowMs,
      mailer: async () => {
        emailCalls += 1;
        return { success: true, messageId: "email-test" };
      },
      pushMailer: async () => {
        pushCalls += 1;
        return { success: true, sentCount: 1, failedCount: 0 };
      },
    }
  );

  assert.equal(emailCalls, 1);
  assert.equal(pushCalls, 1);
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

  const optedOutReservations = rpcCalls.filter(
    (call) => call.name === "reserve_product_interest_channel_delivery"
  );
  assert.equal(optedOutReservations.length, 0);
  assert.equal(optedOutResult.jobs[0].selected, 0);
});
