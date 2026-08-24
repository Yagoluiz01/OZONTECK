import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import {
  createRequestLogger,
  shouldSkipRequestLog,
} from "../middlewares/requestLogger.middleware.js";

test("produção não grava leituras públicas bem-sucedidas", () => {
  assert.equal(
    shouldSkipRequestLog(
      { method: "GET", path: "/api/store/products" },
      { statusCode: 200 },
      "production",
    ),
    true,
  );

  assert.equal(
    shouldSkipRequestLog(
      {
        method: "GET",
        path: "/active",
        originalUrl: "/api/banners/active?origem=teste",
      },
      { statusCode: 304 },
      "production",
    ),
    true,
  );
});

test("integração usa a URL original depois de passar por roteador montado", async () => {
  const accessLogs = [];
  const app = express();
  const router = express.Router();

  app.use(createRequestLogger({
    nodeEnv: "production",
    stream: {
      write(line) {
        accessLogs.push(String(line));
      },
    },
  }));

  router.get("/products", (req, res) => {
    res.status(200).json({ success: true, products: [] });
  });

  app.use("/api/store", router);
  app.use((req, res) => res.status(404).json({ success: false }));

  const server = await new Promise((resolve) => {
    const listeningServer = app.listen(0, "127.0.0.1", () => resolve(listeningServer));
  });

  try {
    const address = server.address();
    await fetch(`http://127.0.0.1:${address.port}/api/store/products`);
    await fetch(`http://127.0.0.1:${address.port}/api/rota-inexistente`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }

  assert.equal(accessLogs.length, 1);
  assert.match(accessLogs[0], /GET \/api\/rota-inexistente 404/);
  assert.doesNotMatch(accessLogs[0], /api\/store\/products/);
});

test("erros públicos continuam registrados", () => {
  assert.equal(
    shouldSkipRequestLog(
      { method: "GET", path: "/api/store/products" },
      { statusCode: 500 },
      "production",
    ),
    false,
  );
});

test("pedido, pagamento e escrita continuam registrados", () => {
  assert.equal(
    shouldSkipRequestLog(
      { method: "POST", path: "/api/store/orders" },
      { statusCode: 201 },
      "production",
    ),
    false,
  );

  assert.equal(
    shouldSkipRequestLog(
      { method: "POST", path: "/api/store/payments" },
      { statusCode: 200 },
      "production",
    ),
    false,
  );
});

test("desenvolvimento mantém todos os logs para diagnóstico", () => {
  assert.equal(
    shouldSkipRequestLog(
      { method: "GET", path: "/api/store/products" },
      { statusCode: 200 },
      "development",
    ),
    false,
  );
});
