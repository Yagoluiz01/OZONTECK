import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDirectory = dirname(fileURLToPath(import.meta.url));

function readSource(relativePath) {
  return readFileSync(join(testDirectory, "..", relativePath), "utf8");
}

test("endpoints legados de IA exigem administrador com ai.use", () => {
  const source = readSource("routes/ai.routes.js");

  assert.match(source, /router\.use\(requireAdminAuth\)/);
  assert.match(source, /router\.use\(enrichAdminPermissions\)/);
  assert.match(source, /router\.use\(requirePermission\("ai\.use"\)\)/);
});

test("chat administrativo também exige a permissão ai.use", () => {
  const source = readSource("routes/adminAi.routes.js");

  assert.match(source, /requireAdminAuth/);
  assert.match(source, /enrichAdminPermissions/);
  assert.match(source, /requirePermission\("ai\.use"\)/);
});

test("todas as superfícies de IA usam o limite específico", () => {
  const source = readSource("app.js");

  assert.match(
    source,
    /app\.use\("\/api\/admin\/ai", adminAiLimiter, adminAiRoutes\)/
  );
  assert.match(source, /app\.use\("\/api\/ai", adminAiLimiter, aiRoutes\)/);
  assert.match(source, /req\.path\.startsWith\("\/api\/ai"\)/);
});

test("identidade e permissões da IA vêm somente da sessão validada", () => {
  const source = readSource("routes/ai.routes.js");

  assert.match(source, /user:\s*req\.admin/);
  assert.match(source, /permissions,/);
  assert.doesNotMatch(source, /req\.body\?\.user/);
  assert.doesNotMatch(source, /req\.body\?\.permissions/);
  assert.doesNotMatch(source, /req\.body\?\.requestId/);
});

test("contextos solicitados são filtrados pelas permissões reais", () => {
  const source = readSource("routes/ai.routes.js");

  assert.match(source, /filterContextsByPermission\(requested, permissions\)/);
  assert.match(source, /permissions\.includes\("\*"\)/);
});

test("rotas legadas não expõem mensagem interna nem stack", () => {
  const source = readSource("routes/ai.routes.js");

  assert.match(source, /buildPublicApiError/);
  assert.doesNotMatch(source, /error:\s*error\??\.message/);
  assert.doesNotMatch(source, /stack:\s*error\??\.stack/);
});
