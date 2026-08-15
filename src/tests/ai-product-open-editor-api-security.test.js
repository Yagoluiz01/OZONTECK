import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const routesSource = readFileSync(
  join(testDirectory, "..", "routes", "products.routes.js"),
  "utf8"
);

test("consulta direta do produto exige sessão administrativa", () => {
  assert.match(routesSource, /router\.get\("\/:id", requireAuth/);
});

test("consulta direta aceita somente UUID e codifica o filtro enviado ao banco", () => {
  assert.match(routesSource, /PRODUCT_ID_PATTERN\.test\(productId\)/);
  assert.match(routesSource, /encodeURIComponent\(String\(productId/);
});

test("consulta direta não expõe detalhes internos", () => {
  assert.match(routesSource, /message: "Erro interno ao buscar produto"/);
  assert.doesNotMatch(routesSource, /details:\s*error/);
  assert.doesNotMatch(routesSource, /stack:\s*error/);
});
