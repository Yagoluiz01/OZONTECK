import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

process.env.PORT ||= "5057";
process.env.SUPABASE_URL ||= "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-role-key";
process.env.SUPABASE_ANON_KEY ||= "test-anon-key";
process.env.JWT_SECRET ||= "test-jwt-secret-with-enough-entropy";
process.env.FRONTEND_URL ||= "https://loja.example.com";
process.env.STORE_FRONTEND_URL ||= "https://loja.example.com";
process.env.API_BASE_URL ||= "https://api.example.com";
process.env.MARKETING_PUBLIC_API_URL ||= "https://api.example.com";
process.env.MARKETING_CLICK_TOKEN_SECRET ||=
  "test-marketing-click-secret-with-enough-entropy";
process.env.MARKETING_CAMPAIGN_WORKER_ENABLED = "false";
process.env.WEB_PUSH_PUBLIC_KEY ||= "test-web-push-public-key";
process.env.WEB_PUSH_PRIVATE_KEY ||= "test-web-push-private-key";
process.env.WEB_PUSH_CONTACT_EMAIL ||= "push@example.com";

const __filename = fileURLToPath(import.meta.url);
const srcRoot = path.resolve(path.dirname(__filename), "..");

function read(relativePath) {
  return fs.readFileSync(path.join(srcRoot, relativePath), "utf8");
}

test("campanha nasce em simulação, somente com Web Push e URL da própria loja", async () => {
  const {
    normalizeMarketingCampaignInput,
    normalizeStoreDestinationUrl,
  } = await import("../services/marketingCampaign.service.js");

  const result = normalizeMarketingCampaignInput({
    name: "Lançamento seguro",
    campaign_type: "product_campaign",
    audience_mode: "smart",
    title: "Nova fragrância",
    body: "Conheça a novidade.",
    destination_url: "/pages-html/loja/catalogo.html",
  });

  assert.equal(result.campaign.dry_run, true);
  assert.deepEqual(result.campaign.channels, ["web_push"]);
  assert.equal(
    result.campaign.destination_url,
    "https://loja.example.com/pages-html/loja/catalogo.html"
  );
  assert.throws(
    () => normalizeStoreDestinationUrl("https://site-malicioso.example/produto"),
    /domínio oficial da loja/i
  );
});

test("imagem de campanha fica restrita às origens autorizadas", async () => {
  const { normalizeMarketingCampaignInput } = await import(
    "../services/marketingCampaign.service.js"
  );
  const base = {
    name: "Campanha",
    campaign_type: "announcement",
    audience_mode: "all_opted_in",
    title: "Aviso",
    body: "Mensagem",
  };

  assert.equal(
    normalizeMarketingCampaignInput({
      ...base,
      image_url: "https://example.supabase.co/storage/v1/object/public/a.webp",
    }).campaign.image_url,
    "https://example.supabase.co/storage/v1/object/public/a.webp"
  );
  assert.throws(
    () => normalizeMarketingCampaignInput({
      ...base,
      image_url: "https://tracker.example/pixel.gif",
    }),
    /armazenamento autorizado/i
  );
});

test("audiência inteligente inclui descoberta e exclui categoria incompatível", async () => {
  const { selectMarketingAudience } = await import(
    "../services/marketingAudience.service.js"
  );
  const now = Date.parse("2026-08-27T12:00:00.000Z");
  const subscriptions = [
    { id: "s1", customer_id: "11111111-1111-4111-8111-111111111111" },
    { id: "s2", customer_id: "22222222-2222-4222-8222-222222222222" },
    { id: "s3", visitor_id: "visitor-new" },
  ];
  const eligible = (customerId, category) => ({
    customer_id: customerId,
    category_key: category,
    category_score: 90,
    confidence: 90,
    qualifying_signal_count: 3,
    last_signal_at: new Date(now - 60_000).toISOString(),
  });

  const result = selectMarketingAudience({
    campaign: {
      audience_mode: "smart",
      category_keys: ["perfumes_masculinos"],
      discovery_enabled: true,
    },
    subscriptions,
    customerProfiles: [
      eligible("11111111-1111-4111-8111-111111111111", "perfumes_masculinos"),
      eligible("22222222-2222-4222-8222-222222222222", "perfumes_femininos"),
    ],
    visitorProfiles: [],
    eligibilityConfig: {
      minCategoryScore: 35,
      minConfidence: 30,
      minQualifyingSignals: 1,
      minMatchScore: 55,
      lookbackDays: 30,
      halfLifeHours: 72,
    },
    nowMs: now,
  });

  assert.equal(result.uniqueRecipients, 3);
  assert.equal(result.selectedRecipients, 2);
  assert.equal(result.interestRecipients, 1);
  assert.equal(result.discoveryRecipients, 1);
  assert.equal(result.excludedByInterest, 1);
});

test("todos com consentimento inclui clientes e visitantes, respeitando supressão", async () => {
  const { selectMarketingAudience } = await import(
    "../services/marketingAudience.service.js"
  );
  const suppressedId = "11111111-1111-4111-8111-111111111111";
  const result = selectMarketingAudience({
    campaign: { audience_mode: "all_opted_in", category_keys: [] },
    subscriptions: [
      { id: "s1", customer_id: suppressedId },
      { id: "s2", visitor_id: "visitor-opted-in" },
    ],
    suppressedCustomerIds: [suppressedId],
  });

  assert.equal(result.selectedRecipients, 1);
  assert.equal(result.allOptedInRecipients, 1);
  assert.equal(result.suppressedRecipients, 1);

  const source = read("services/marketingAudience.service.js");
  assert.match(source, /includeDeliverySecrets: includeRecipients/);
  assert.match(source, /"id,customer_id,visitor_id,last_seen_at"/);
});

test("token de clique é opaco, determinístico e vinculado ao destinatário", async () => {
  const { createMarketingClickTokenForRecipient } = await import(
    "../services/marketingCampaign.service.js"
  );
  const campaignId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const recipientId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const first = createMarketingClickTokenForRecipient(campaignId, recipientId);
  const second = createMarketingClickTokenForRecipient(campaignId, recipientId);

  assert.deepEqual(first, second);
  assert.match(first.token, /^[A-Za-z0-9_-]{40,100}$/);
  assert.match(first.tokenHash, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(first.token, /aaaaaaaa|bbbbbbbb/i);
});

test("payload Push não expõe identificador interno do destinatário", async () => {
  const { buildMarketingCampaignPushPayload } = await import(
    "../services/customerMarketingPush.service.js"
  );
  const payload = buildMarketingCampaignPushPayload({
    title: "Novidade",
    body: "Conheça o produto.",
    url: "https://loja.example.com/produto",
    campaignId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    recipientId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    campaignType: "product_campaign",
    storefrontUrl: "https://loja.example.com",
  });

  assert.equal(payload.data.campaign_id, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  assert.equal(Object.hasOwn(payload.data, "recipient_id"), false);
  assert.doesNotMatch(JSON.stringify(payload), /bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/);
});

test("aceite do provedor não vira falha quando apenas a telemetria falha", async () => {
  const { sendMarketingPushSubscription } = await import(
    "../services/customerMarketingPush.service.js"
  );
  const subscription = {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    endpoint: "https://fcm.googleapis.com/fcm/send/test-endpoint",
    p256dh: "A".repeat(64),
    auth: "B".repeat(24),
  };
  const client = {
    from() {
      return {
        update() { return this; },
        async eq() {
          return { error: { message: "telemetria indisponível" } };
        },
      };
    },
  };

  const originalError = console.error;
  console.error = () => {};
  try {
    const result = await sendMarketingPushSubscription(
      { subscription, payload: { title: "Teste" } },
      {
        client,
        sender: async () => ({ statusCode: 201, headers: {} }),
      }
    );

    assert.equal(result.success, true);
    assert.equal(result.providerStatusCode, 201);
    assert.equal(result.telemetryUpdated, false);
  } finally {
    console.error = originalError;
  }
});

test("atribuição de clique não vaza identificadores e só converte pedido pago", () => {
  const clickRoute = read("routes/storeMarketing.routes.js");
  const attribution = read("services/marketingAttribution.service.js");
  const orderRoute = read("routes/store.routes.js");
  const paidOrder = read("jobs/processPaidOrder.js");

  assert.match(clickRoute, /destination\.hash = new URLSearchParams\(\{ oz_mkt:/);
  assert.match(clickRoute, /Referrer-Policy.*no-referrer/s);
  assert.match(orderRoute, /recordMarketingOrderAttribution/);
  assert.match(paidOrder, /finalizeMarketingOrderAttribution\(order\)/);
  assert.match(attribution, /\.eq\("status", "pending"\)/);
  assert.doesNotMatch(attribution, /token:/);
});

test("worker permanece fechado por padrão", async () => {
  const {
    getMarketingCampaignWorkerConfig,
    normalizeMarketingWorkerPublicOrigin,
  } = await import(
    "../services/marketingCampaignWorker.service.js"
  );
  const config = getMarketingCampaignWorkerConfig();

  assert.equal(config.enabled, false);
  assert.equal(config.automationRealSendEnabled, false);
  assert.ok(config.recipientConcurrency >= 1);
  assert.ok(config.jobLimit >= 1);
  assert.ok(config.cancellationBatchSize >= 1);

  const worker = read("services/marketingCampaignWorker.service.js");
  assert.match(worker, /if \(campaign\.dry_run\)/);
  assert.match(worker, /status: dryRun \? "draft" : "completed"/);
  assert.match(worker, /simulated_attempts: audience\.selectedDevices/);
  assert.match(worker, /heartbeatAndGetCampaignStatus/);
  assert.match(worker, /\["paused", "cancelled"\]\.includes\(currentStatus\)/);
  assert.match(worker, /previouslyAccepted/);
  assert.match(worker, /campaign\.source !== "manual"/);
  assert.match(worker, /if \(result\.skipped\) skipped \+= 1/);
  assert.equal(
    normalizeMarketingWorkerPublicOrigin("https://api.example.com/path"),
    "https://api.example.com"
  );
  assert.throws(
    () => normalizeMarketingWorkerPublicOrigin("http://api.example.com"),
    /origem segura/i
  );
});

test("disparador interno é opt-in, assíncrono e consolida chamadas concorrentes", async () => {
  const {
    getInlineMarketingDispatcherConfig,
    triggerInlineMarketingCampaignProcessing,
    waitForInlineMarketingCampaignProcessing,
  } = await import(
    "../services/marketingCampaignInlineDispatcher.service.js"
  );

  assert.equal(getInlineMarketingDispatcherConfig({ enabled: false }).enabled, false);

  let disabledCalls = 0;
  const disabled = triggerInlineMarketingCampaignProcessing("test_disabled", {
    config: { enabled: false },
    runner: async () => {
      disabledCalls += 1;
      return { claimed: 0, completed: 0, failed: 0 };
    },
  });
  assert.deepEqual(disabled, {
    enabled: false,
    scheduled: false,
    coalesced: false,
  });
  assert.equal(disabledCalls, 0);

  let calls = 0;
  const runner = async ({ config }) => {
    calls += 1;
    assert.equal(config.enabled, true);
    return { claimed: 0, completed: 0, failed: 0 };
  };

  const first = triggerInlineMarketingCampaignProcessing("test_publish", {
    config: { enabled: true },
    runner,
  });
  const second = triggerInlineMarketingCampaignProcessing("test_publish", {
    config: { enabled: true },
    runner,
  });

  assert.deepEqual(first, { enabled: true, scheduled: true, coalesced: false });
  assert.deepEqual(second, { enabled: true, scheduled: false, coalesced: true });

  await waitForInlineMarketingCampaignProcessing();
  assert.equal(calls, 1);

  let slowCalls = 0;
  let signalStarted;
  let release;
  const started = new Promise((resolve) => {
    signalStarted = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const slowRunner = async () => {
    slowCalls += 1;
    if (slowCalls === 1) {
      signalStarted();
      await gate;
    }
    return { claimed: 0, completed: 0, failed: 0 };
  };

  triggerInlineMarketingCampaignProcessing("test_running", {
    config: { enabled: true },
    runner: slowRunner,
  });
  await started;
  const whileRunning = triggerInlineMarketingCampaignProcessing("test_running", {
    config: { enabled: true },
    runner: slowRunner,
  });
  assert.equal(whileRunning.coalesced, true);
  release();
  await waitForInlineMarketingCampaignProcessing();
  assert.equal(slowCalls, 2);

  const routes = read("routes/adminMarketingCampaigns.routes.js");
  const server = read("server.js");
  assert.match(routes, /triggerInlineMarketingCampaignProcessing\("admin_publish"\)/);
  assert.match(routes, /campaign\.status === "queued"/);
  assert.match(server, /startup_recovery/);
  assert.match(server, /interval_recovery/);
});

test("simulação volta ao rascunho sem reservar destinatários", async () => {
  const { processMarketingCampaignJobs } = await import(
    "../services/marketingCampaignWorker.service.js"
  );
  const campaignId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const updates = [];
  const rpcCalls = [];

  function resultFor(table, operation, columns) {
    if (operation === "update") return { data: null, error: null };
    if (table === "marketing_campaigns") {
      if (columns === "status") return { data: { status: "processing" }, error: null };
      return {
        data: {
          id: campaignId,
          status: "queued",
          dry_run: true,
          audience_mode: "smart",
          category_keys: ["perfumes_masculinos"],
          discovery_enabled: true,
          daily_cap: 1,
          weekly_cap: 2,
          channels: ["web_push"],
          title: "Simulação",
          body: "Sem envio real",
        },
        error: null,
      };
    }
    if (table === "marketing_campaign_items") return { data: [], error: null };
    if (table === "customer_marketing_push_subscriptions") {
      return { data: [], error: null };
    }
    return { data: [], error: null };
  }

  function queryBuilder(table) {
    const builder = {
      operation: "select",
      columns: "*",
      select(columns = "*") {
        this.operation = "select";
        this.columns = columns;
        return this;
      },
      update(values) {
        this.operation = "update";
        updates.push({ table, values });
        return this;
      },
      eq() { return this; },
      in() { return this; },
      is() { return this; },
      order() { return this; },
      range() { return this; },
      maybeSingle() {
        return Promise.resolve(resultFor(table, this.operation, this.columns));
      },
      then(resolve, reject) {
        return Promise.resolve(
          resultFor(table, this.operation, this.columns)
        ).then(resolve, reject);
      },
    };
    return builder;
  }

  const client = {
    from(table) { return queryBuilder(table); },
    async rpc(name) {
      rpcCalls.push(name);
      if (name === "claim_marketing_campaign_jobs") {
        return {
          data: [{
            id: 7,
            campaign_id: campaignId,
            attempts: 1,
            max_attempts: 5,
          }],
          error: null,
        };
      }
      assert.fail(`RPC inesperada durante dry-run: ${name}`);
    },
  };

  const result = await processMarketingCampaignJobs(
    {
      trigger: "test",
      config: {
        enabled: true,
        storefrontUrl: "https://loja.example.com",
      },
    },
    { client }
  );

  assert.equal(result.completed, 1);
  assert.equal(result.failed, 0);
  assert.equal(result.jobs[0].dry_run, true);
  assert.equal(result.jobs[0].simulated_attempts, 0);
  assert.deepEqual(rpcCalls, ["claim_marketing_campaign_jobs"]);
  assert.ok(
    updates.some(
      ({ table, values }) =>
        table === "marketing_campaigns" && values.status === "draft"
    )
  );
  assert.equal(
    updates.some(({ table }) => table === "marketing_campaign_recipients"),
    false
  );
});

test("migration protege RLS, concorrência, métricas e rollback", () => {
  const migration = read("sql/20260827-marketing-campaign-platform.sql");
  const rollback = read("sql/20260827-marketing-campaign-platform-rollback.sql");
  const verification = read(
    "sql/20260827-marketing-campaign-platform-verification.sql"
  );

  for (const fragment of [
    "default false",
    "default true",
    "enable row level security",
    "from public, anon, authenticated",
    "for update of job skip locked",
    "pg_advisory_xact_lock",
    "with (security_invoker = true)",
    "marketing_campaign_daily_metrics",
    "provider_accepted",
    "register_marketing_campaign_click",
    "save_marketing_campaign_draft",
    "publish_marketing_campaign",
    "marketing_order_attributions_status_chk",
    "where status = 'converted'",
    "last_simulated_at timestamptz",
    "products_enqueue_smart_marketing_campaign",
    "drop trigger if exists products_enqueue_new_interest_campaign",
    "marketing_delivery_attempts_subscription_idx",
    "marketing_order_attributions_campaign_idx",
  ]) {
    assert.match(migration.toLowerCase(), new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(rollback, /products_enqueue_new_interest_campaign/);
  assert.match(rollback, /drop function if exists public\.save_marketing_campaign_draft/);
  assert.match(rollback, /drop table if exists public\.marketing_campaigns/);
  assert.match(verification, /foreign_key_support_indexes_present/);
});

test("rotas administrativas exigem RBAC e cliques não aceitam redirecionamento externo", () => {
  const routes = read("routes/adminMarketingCampaigns.routes.js");
  const clickRoute = read("routes/storeMarketing.routes.js");
  const app = read("app.js");
  const worker = read("services/marketingCampaignWorker.service.js");

  assert.match(routes, /requireAdminAuth/);
  assert.match(routes, /"\/products"[\s\S]*campaigns\.manage/);
  for (const permission of [
    "campaigns.view",
    "campaigns.manage",
    "campaigns.publish",
    "campaigns.analytics",
    "promotions.manage",
  ]) {
    assert.match(routes, new RegExp(permission.replace(".", "\\.")));
  }
  assert.match(clickRoute, /normalizeStoreDestinationUrl\(click\.destination_url\)/);
  assert.match(app, /\/api\/admin\/campaigns/);
  assert.match(app, /\/api\/store\/marketing/);
  assert.match(worker, /recipient\.existing/);
  const campaignService = read("services/marketingCampaign.service.js");
  assert.match(campaignService, /MARKETING_AUTOMATION_REAL_SEND_ENABLED/);
  assert.match(campaignService, /save_marketing_campaign_draft/);
});

test("exclusão de campanha preserva todo histórico operacional", () => {
  const route = read("routes/adminMarketingCampaigns.routes.js");
  const service = read("services/marketingCampaign.service.js");

  assert.match(route, /router\.delete\([\s\S]*requirePermission\("campaigns\.manage"\)/);
  assert.match(service, /export async function deleteMarketingCampaign/);
  assert.match(service, /campaign\.status !== "draft"/);
  assert.match(service, /campaign\.published_at/);
  assert.match(service, /campaign\.last_simulated_at/);
  assert.match(service, /from\("marketing_campaign_jobs"\)/);
  assert.match(service, /campaign_has_history/);
  assert.match(service, /\.delete\(\)[\s\S]*\.eq\("status", "draft"\)/);
});
