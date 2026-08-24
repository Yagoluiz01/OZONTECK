import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { isPublicCachedReadRequest } from "../middlewares/publicStoreReadLimiter.middleware.js";

const appPath = new URL("../app.js", import.meta.url);
const limiterPath = new URL(
  "../middlewares/publicStoreReadLimiter.middleware.js",
  import.meta.url,
);

test("leituras públicas em cache usam a faixa de alta demanda", () => {
  const paths = [
    "/api/store/theme",
    "/api/store/products",
    "/api/store/products/home",
    "/api/store/products/produto-123",
    "/api/store/categories/active",
    "/api/store/marketing/pixels",
    "/api/banners/active",
    "/api/store/health",
  ];

  for (const path of paths) {
    assert.equal(
      isPublicCachedReadRequest({ method: "GET", path }),
      true,
      `${path} deveria usar a faixa pública`,
    );
  }
});

test("pagamento, pedido, frete e escrita continuam fora da faixa pública", () => {
  const protectedRequests = [
    { method: "POST", path: "/api/store/orders" },
    { method: "GET", path: "/api/store/orders/123/status" },
    { method: "POST", path: "/api/store/shipping/quote" },
    { method: "POST", path: "/api/store/payments" },
    { method: "POST", path: "/api/tracking/event" },
    { method: "POST", path: "/api/banners/tracking" },
  ];

  for (const request of protectedRequests) {
    assert.equal(isPublicCachedReadRequest(request), false);
  }
});

test("faixa pública vem antes da geral e a geral ignora somente essas leituras", () => {
  const source = fs.readFileSync(appPath, "utf8");
  const publicLimiterPosition = source.indexOf("return publicStoreReadLimiter(req, res, next)");
  const globalLimiterPosition = source.indexOf("app.use(globalLimiter)");

  assert.ok(publicLimiterPosition >= 0);
  assert.ok(globalLimiterPosition > publicLimiterPosition);
  assert.match(
    source,
    /return req\.method === "OPTIONS" \|\| isPublicCachedReadRequest\(req\)/,
  );
});

test("limite público padrão suporta seis mil leituras e pode ser configurado", () => {
  const source = fs.readFileSync(limiterPath, "utf8");

  assert.match(source, /PUBLIC_STORE_READ_RATE_LIMIT_MAX/);
  assert.match(source, /6_000/);
  assert.match(source, /standardHeaders: true/);
  assert.match(source, /legacyHeaders: false/);
});
