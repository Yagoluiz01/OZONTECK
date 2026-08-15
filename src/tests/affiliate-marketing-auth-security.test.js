import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const routeSource = readFileSync(
  join(testDirectory, "..", "routes", "affiliateMarketing.routes.js"),
  "utf8"
);
const appSource = readFileSync(
  join(testDirectory, "..", "app.js"),
  "utf8"
);

test("listagem completa do Kit de Divulgação exige sessão de afiliado", () => {
  assert.match(
    routeSource,
    /router\.get\('\/',\s*requireAffiliateAuth,\s*async\s*\(req, res\)\s*=>/
  );
  assert.doesNotMatch(routeSource, /router\.get\('\/',\s*async\s*\(req, res\)\s*=>/);
});

test("consulta do Kit por produto exige sessão de afiliado", () => {
  assert.match(
    routeSource,
    /router\.get\('\/product\/:productId',\s*requireAffiliateAuth,\s*async\s*\(req, res\)\s*=>/
  );
  assert.doesNotMatch(
    routeSource,
    /router\.get\('\/product\/:productId',\s*async\s*\(req, res\)\s*=>/
  );
});

test("mutações do Kit continuam autenticadas e usam a identidade do token", () => {
  assert.match(routeSource, /router\.post\('\/action',\s*requireAffiliateAuth/);
  assert.match(routeSource, /router\.post\('\/training\/start',\s*requireAffiliateAuth/);
  assert.match(routeSource, /router\.post\('\/training\/complete',\s*requireAffiliateAuth/);
  assert.match(routeSource, /affiliate_id:\s*req\.affiliateId/);
  assert.doesNotMatch(routeSource, /affiliate_id:\s*req\.body/);
});

test("roteador protegido permanece montado apenas na área do afiliado", () => {
  assert.match(
    appSource,
    /app\.use\('\/api\/affiliate\/marketing-kit',\s*affiliateMarketingRoutes\)/
  );
  assert.doesNotMatch(appSource, /app\.use\('\/api\/public\/[^']*marketing-kit/);
});
