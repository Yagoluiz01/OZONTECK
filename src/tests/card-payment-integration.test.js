import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";

process.env.NODE_ENV = "test";
process.env.PORT = "5000";
process.env.SUPABASE_URL = "https://supabase.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test";
process.env.SUPABASE_ANON_KEY = "anon-test";
process.env.JWT_SECRET = "jwt-test-secret-with-enough-length";
process.env.FRONTEND_URL = "https://store.test";
process.env.API_BASE_URL = "https://api.test";
process.env.MERCADO_PAGO_ACCESS_TOKEN = "TEST-access-token";
process.env.MERCADO_PAGO_PUBLIC_KEY = "TEST-public-key";
process.env.MERCADO_PAGO_WEBHOOK_SECRET = "webhook-test-secret";

const [{ default: express }, { default: storeRoutes }] = await Promise.all([
  import("express"),
  import("../routes/store.routes.js"),
]);

function requestJson(server, { method = "GET", path = "/", headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const address = server.address();
    const payload = body === undefined ? "" : JSON.stringify(body);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: address.port,
        method,
        path,
        headers: {
          Accept: "application/json",
          ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
          ...headers,
        },
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { raw += chunk; });
        res.on("end", () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            data: raw ? JSON.parse(raw) : null,
          });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test("pagamento de cartão usa valor e pagador do pedido, não do navegador", async (t) => {
  const accessToken = "order-access-test";
  const order = {
    id: "11111111-1111-4111-8111-111111111111",
    order_number: "OZT-TEST-CARD",
    total_amount: 51.41,
    customer_email: "cliente@pedido.test",
    customer_cpf: "12345678901",
    payment_status: "pending",
    public_access_token_hash: crypto.createHash("sha256").update(accessToken).digest("hex"),
  };

  const outbound = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    outbound.push({ url: target, options });

    if (target.startsWith("https://supabase.test/rest/v1/orders?") && options.method === "GET") {
      return new Response(JSON.stringify([order]), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    if (target.startsWith("https://supabase.test/rest/v1/orders?") && options.method === "PATCH") {
      return new Response(JSON.stringify([{ ...order, ...JSON.parse(options.body || "{}") }]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (target === "https://supabase.test/rest/v1/rpc/apply_mercado_pago_payment_transition") {
      return new Response(JSON.stringify({
        success: true,
        claimed: true,
        order: { ...order, payment_status: "paid", order_status: "paid" },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    if (target === "https://api.mercadopago.com/v1/payments") {
      const sent = JSON.parse(options.body || "{}");
      assert.equal(sent.transaction_amount, 51.41);
      assert.equal(sent.payer.email, "cliente@pedido.test");
      assert.equal(sent.payer.identification.number, "12345678901");
      assert.equal(sent.external_reference, order.order_number);
      assert.equal(sent.metadata.order_id, order.id);
      assert.equal(sent.token, "card-token-test");
      assert.equal(options.headers["X-Idempotency-Key"].includes("12345678901"), false);

      return new Response(JSON.stringify({
        id: 987654321,
        status: "approved",
        status_detail: "accredited",
        transaction_amount: 51.41,
        currency_id: "BRL",
        external_reference: order.order_number,
        metadata: { order_id: order.id },
        installments: 1,
        payment_method_id: "visa",
        payment_type_id: "credit_card",
        transaction_details: { net_received_amount: 49.90 },
      }), { status: 201, headers: { "Content-Type": "application/json" } });
    }

    throw new Error(`Fetch inesperado no teste: ${target}`);
  };

  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use("/api/store", storeRoutes);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => {
    globalThis.fetch = originalFetch;
    server.close();
  });

  const result = await requestJson(server, {
    method: "POST",
    path: "/api/store/payments",
    headers: {
      "X-Order-Access-Token": accessToken,
      "X-Idempotency-Key": "oz-card-integration-1234567890",
    },
    body: {
      orderNumber: order.order_number,
      token: "card-token-test",
      installments: 1,
      paymentMethodId: "visa",
      payer: {
        email: "atacante@nao-confiar.test",
        identification: { type: "CPF", number: "00000000000" },
      },
    },
  });

  assert.equal(result.status, 200);
  assert.equal(result.data.success, true);
  assert.equal(result.data.payment.status, "approved");
  assert.equal(result.data.order.number, order.order_number);
  assert.ok(outbound.some((entry) => entry.url === "https://api.mercadopago.com/v1/payments"));
});

test("pagamento de cartão bloqueia acesso sem token público do pedido", async (t) => {
  const order = {
    id: "22222222-2222-4222-8222-222222222222",
    order_number: "OZT-TEST-FORBIDDEN",
    total_amount: 10,
    customer_email: "cliente@pedido.test",
    customer_cpf: "12345678901",
    payment_status: "pending",
    public_access_token_hash: crypto.createHash("sha256").update("correct-token").digest("hex"),
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.startsWith("https://supabase.test/rest/v1/orders?") && options.method === "GET") {
      return new Response(JSON.stringify([order]), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    throw new Error(`Chamada externa indevida: ${target}`);
  };

  const app = express();
  app.use(express.json());
  app.use("/api/store", storeRoutes);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => {
    globalThis.fetch = originalFetch;
    server.close();
  });

  const result = await requestJson(server, {
    method: "POST",
    path: "/api/store/payments",
    headers: {
      "X-Idempotency-Key": "oz-card-integration-9876543210",
    },
    body: {
      orderNumber: order.order_number,
      token: "card-token-test",
      installments: 1,
      paymentMethodId: "visa",
    },
  });

  assert.equal(result.status, 403);
  assert.equal(result.data.success, false);
});

test("consulta de status do pedido exige token de acesso e retorna dados mínimos", async (t) => {
  const accessToken = "status-access-token";
  const order = {
    id: "33333333-3333-4333-8333-333333333333",
    order_number: "OZT-TEST-STATUS",
    total_amount: 51.41,
    customer_email: "nao-expor@pedido.test",
    customer_cpf: "12345678901",
    payment_status: "paid",
    order_status: "paid",
    tracking_code: null,
    public_access_token_hash: crypto.createHash("sha256").update(accessToken).digest("hex"),
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.startsWith("https://supabase.test/rest/v1/orders?") && options.method === "GET") {
      return new Response(JSON.stringify([order]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error(`Fetch inesperado no teste: ${target}`);
  };

  const app = express();
  app.use(express.json());
  app.use("/api/store", storeRoutes);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => {
    globalThis.fetch = originalFetch;
    server.close();
  });

  const forbidden = await requestJson(server, {
    path: `/api/store/orders/${encodeURIComponent(order.order_number)}/status`,
  });
  assert.equal(forbidden.status, 403);

  const allowed = await requestJson(server, {
    path: `/api/store/orders/${encodeURIComponent(order.order_number)}/status`,
    headers: { "X-Order-Access-Token": accessToken },
  });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.data.order.payment_status, "paid");
  assert.equal("customer_email" in allowed.data.order, false);
  assert.equal("customer_cpf" in allowed.data.order, false);
});
