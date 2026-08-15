import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildPublicApiError } from "../utils/publicApiError.js";

const testDirectory = dirname(fileURLToPath(import.meta.url));

function readSource(relativePath) {
  return readFileSync(join(testDirectory, "..", relativePath), "utf8");
}

test("erros internos não expõem mensagens da infraestrutura", () => {
  const result = buildPublicApiError(
    new Error('relation "affiliate_payouts" does not exist; service_role=secret'),
    { fallbackMessage: "Erro interno no painel do afiliado." }
  );

  assert.equal(result.status, 500);
  assert.deepEqual(result.body, {
    success: false,
    message: "Erro interno no painel do afiliado.",
  });
});

test("erros de validação 4xx preservam a orientação segura ao usuário", () => {
  const error = new Error("Tipo de chave Pix inválido.");
  error.statusCode = 400;

  const result = buildPublicApiError(error, {
    fallbackMessage: "Erro interno no painel do afiliado.",
  });

  assert.equal(result.status, 400);
  assert.equal(result.body.message, "Tipo de chave Pix inválido.");
});

test("erro 4xx de serviço interno também permanece oculto", () => {
  const error = new Error('column affiliate_secret does not exist');
  error.statusCode = 400;
  error.expose = false;

  const result = buildPublicApiError(error, {
    fallbackMessage: "Erro interno no feed dos afiliados.",
  });

  assert.equal(result.status, 400);
  assert.equal(result.body.message, "Erro interno no feed dos afiliados.");
});

test("status inválido falha fechado como erro interno", () => {
  const error = new Error("detalhe que não deve sair");
  error.statusCode = 302;

  const result = buildPublicApiError(error, {
    fallbackMessage: "Erro interno.",
  });

  assert.equal(result.status, 500);
  assert.equal(result.body.message, "Erro interno.");
});

test("controladores de afiliado usam o sanitizador central", () => {
  for (const sourcePath of [
    "controllers/affiliatePortal.controller.js",
    "controllers/affiliateCommunityAchievements.controller.js",
    "controllers/affiliatePush.controller.js",
    "routes/affiliateFeed.routes.js",
    "routes/affiliateMarketing.routes.js",
  ]) {
    const source = readSource(sourcePath);
    assert.match(source, /buildPublicApiError/);
  }

  assert.doesNotMatch(
    readSource("controllers/affiliatePortal.controller.js"),
    /message:\s*error\.message/
  );
  assert.doesNotMatch(
    readSource("controllers/affiliateCommunityAchievements.controller.js"),
    /details:\s*process\.env\.NODE_ENV/
  );
});

test("erros vindos do Supabase são marcados como internos", () => {
  for (const sourcePath of [
    "services/affiliatePortal.service.js",
    "services/affiliateCommunityAchievements.service.js",
    "services/affiliateFeed.service.js",
    "services/affiliateFeedStories.service.js",
  ]) {
    const source = readSource(sourcePath);
    assert.match(source, /error\.expose = false/);
  }
});

test("falhas internas de push não são rebaixadas para erro 400", () => {
  const source = readSource("controllers/affiliatePush.controller.js");
  assert.doesNotMatch(source, /catch \(error\) \{\s*return fail\(res, error, 400\)/);
  assert.match(source, /return fail\(res, new Error\("Inscrição de notificação inválida\."\), 400\)/);
  assert.match(source, /return fail\(res, new Error\("Endpoint não enviado\."\), 400\)/);
});
