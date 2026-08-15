import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildConservativeDescriptionImprovement,
  findUnsupportedPerfumeClaims,
  improveProductDescription,
} from "../services/AI/products/productDescription.js";

const testDirectory = dirname(fileURLToPath(import.meta.url));

function readSource(relativePath) {
  return readFileSync(join(testDirectory, "..", relativePath), "utf8");
}

test("descrição exige um nome de produto válido", async () => {
  await assert.rejects(
    improveProductDescription({ name: "", ask: async () => ({ success: true, reply: "x" }) }),
    /Informe o nome do produto/
  );
});

test("prompt proíbe conhecimento externo e características não informadas", async () => {
  let receivedSystemPrompt = "";

  await improveProductDescription({
    name: "Perfume Exemplo",
    description: "Produto para cadastro.",
    ask: async ({ systemPrompt }) => {
      receivedSystemPrompt = systemPrompt;
      return { success: true, reply: "Perfume Exemplo. Produto para cadastro." };
    },
  });

  assert.match(receivedSystemPrompt, /Use exclusivamente o NOME COMERCIAL DO PRODUTO/);
  assert.match(receivedSystemPrompt, /Não use conhecimento externo/);
  assert.match(receivedSystemPrompt, /Não deduza nem invente/);
});

test("detecta alegações de perfume ausentes dos dados fornecidos", () => {
  const claims = findUnsupportedPerfumeClaims({
    name: "Perfume Exemplo",
    description: "Uma apresentação curta.",
    result: "Perfume masculino amadeirado, com longa fixação e 100 ml.",
  });

  assert.ok(claims.length >= 3);
});

test("rejeita característica inventada mesmo sem palavras típicas de alegação", () => {
  const claims = findUnsupportedPerfumeClaims({
    name: "Perfume Exemplo",
    description: "Descrição para o catálogo.",
    result: "Perfume Exemplo com baunilha envolvente.",
  });

  assert.ok(claims.includes("term:baunilha"));
  assert.ok(claims.includes("term:envolvente"));
});

test("descrição anterior não autoriza preservar características sem origem confirmada", () => {
  const claims = findUnsupportedPerfumeClaims({
    name: "Perfume Amadeirado Elegance",
    description: "Perfume masculino amadeirado e elegante.",
    result: "Perfume Amadeirado Elegance: masculino, amadeirado e elegante.",
  });

  assert.ok(claims.length >= 2);
});

test("resposta com invenções é substituída por fallback conservador", async () => {
  const result = await improveProductDescription({
    name: "Perfume Exemplo",
    description: "",
    ask: async () => ({
      success: true,
      reply: "Perfume amadeirado masculino com longa fixação.",
    }),
  });

  assert.equal(result.usedFallback, true);
  assert.doesNotMatch(result.description, /amadeirado|masculino|fixação/i);
  assert.match(result.description, /Perfume Exemplo/);
  assert.equal(result.description.split("\n").length, 3);
});

test("resposta idêntica contaminada é substituída sem acumular o texto anterior", async () => {
  const original = "Fragrância masculina amadeirada e elegante.";
  const result = await improveProductDescription({
    name: "Perfume Amadeirado Elegance",
    description: original,
    ask: async () => ({ success: true, reply: original }),
  });

  assert.notEqual(result.description, original);
  assert.match(result.description, /^✨ Conheça Perfume Amadeirado Elegance e transforme sua escolha/);
  assert.doesNotMatch(result.description, /masculina|amadeirada|elegante/i);
  assert.equal(result.description.split("\n").length, 3);
});

test("melhoria conservadora substitui e não reaproveita atributos do texto original", () => {
  const result = buildConservativeDescriptionImprovement({
    name: "Perfume Exemplo",
    description: "Descrição para o catálogo.",
  });

  assert.equal(
    result,
    [
      "✨ Conheça Perfume Exemplo e transforme sua escolha em um momento especial.",
      "💫 Um convite para expressar seu estilo por meio da perfumaria.",
      "💚 Escolha com confiança e leve para sua coleção um perfume para chamar de seu.",
    ].join("\n")
  );
  assert.doesNotMatch(result, /fixação|notas|ml|amadeirado|masculino/i);
});

test("resposta válida mantém no máximo três linhas com emojis neutros", async () => {
  const result = await improveProductDescription({
    name: "Perfume Elegance",
    description: "Texto antigo que deve ser descartado.",
    ask: async () => ({
      success: true,
      reply: [
        "✨ Conheça Perfume Elegance e transforme sua escolha em um momento especial.",
        "💫 Um convite para expressar seu estilo por meio da perfumaria.",
        "💚 Escolha com confiança e leve para sua coleção um perfume para chamar de seu.",
      ].join("\n"),
    }),
  });

  const lines = result.description.split("\n");
  assert.equal(result.usedFallback, false);
  assert.equal(lines.length, 3);
  assert.ok(lines.every((line) => /^(?:✨|💫|💚|📝|📌|🛍️)\s/u.test(line)));
});

test("cliques repetidos não acumulam a descrição produzida anteriormente", async () => {
  const contaminated = [
    "✨ Conheça Donzela e transforme sua escolha em um momento especial.",
    "💫 Fragrância masculina amadeirada e elegante.",
    "💚 Escolha com confiança e leve para sua coleção um perfume para chamar de seu.",
  ].join("\n");

  const result = await improveProductDescription({
    name: "Donzela",
    description: contaminated,
    ask: async () => ({
      success: true,
      reply: [
        "✨ Conheça Donzela e transforme sua escolha em um momento especial.",
        "💫 Um convite para expressar seu estilo por meio da perfumaria.",
        "💚 Escolha com confiança e leve para sua coleção um perfume para chamar de seu.",
      ].join("\n"),
    }),
  });

  assert.equal(result.description.split("\n").length, 3);
  assert.doesNotMatch(result.description, /masculina|amadeirada|elegante/i);
});

test("fallback vazio é persuasivo sem inventar características do perfume", async () => {
  const result = await improveProductDescription({
    name: "Perfume Exemplo",
    description: "",
    ask: async () => ({ success: true, reply: "Resposta fora do formato." }),
  });

  assert.match(result.description, /momento especial/);
  assert.match(result.description, /confiança/);
  assert.match(result.description, /expressar seu estilo/);
  assert.doesNotMatch(result.description, /fixação|projeção|notas|ml|amadeirado|floral/i);
  assert.equal(result.description.split("\n").length, 3);
});

test("rota exige IA e permissão de criação ou edição de produtos", () => {
  const source = readSource("routes/adminAi.routes.js");

  assert.match(source, /"\/products\/improve-description"/);
  assert.match(source, /requirePermission\("ai\.use"\)/);
  assert.match(source, /requireAnyPermission\(\["products\.create", "products\.edit"\]\)/);
});

test("controlador não expõe falhas internas do provedor", () => {
  const source = readSource("controllers/adminAi.controller.js");

  assert.match(source, /ADMIN_AI_PRODUCT_DESCRIPTION_ERROR/);
  assert.match(source, /message: "Não foi possível melhorar a descrição neste momento\."/);
});
