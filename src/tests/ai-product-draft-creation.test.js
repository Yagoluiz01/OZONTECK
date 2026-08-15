import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildAiProductDraftPayload } from "../services/AI/products/productDraft.js";

const testDirectory = dirname(fileURLToPath(import.meta.url));

function readSource(relativePath) {
  return readFileSync(join(testDirectory, "..", relativePath), "utf8");
}

const fixedRandomBytes = () => Buffer.from("01020304", "hex");

test("IA cria somente rascunho mínimo e mantém campos comerciais para edição manual", () => {
  const payload = buildAiProductDraftPayload(
    {
      name: "  Perfume  Elegância  ",
      description: "  Fragrância masculina amadeirada e elegante. ",
      category: " Perfumes ",
      price: 999.99,
      stock_quantity: 500,
      status: "active",
      show_on_home: true,
      image_url: "https://example.test/injetada.png",
    },
    { randomBytes: fixedRandomBytes }
  );

  assert.deepEqual(payload, {
    name: "Perfume Elegância",
    sku: "PERFUME-ELEGANCIA-01020304",
    category: "",
    short_description: [
      "✨ Conheça Perfume Elegância e transforme sua escolha em um momento especial.",
      "💫 Um convite para expressar seu estilo por meio da perfumaria.",
      "💚 Escolha com confiança e leve para sua coleção um perfume para chamar de seu.",
    ].join("\n"),
    price: 0,
    compare_at_price: 0,
    stock_quantity: 0,
    status: "draft",
    show_on_home: false,
    image_url: "",
    image_url_2: "",
  });
});

test("somente o nome é obrigatório e a descrição segura é criada no servidor", () => {
  assert.throws(
    () => buildAiProductDraftPayload({ description: "Descrição" }),
    /nome do produto/i
  );
  const payload = buildAiProductDraftPayload({ name: "Donzela" }, { randomBytes: fixedRandomBytes });
  assert.match(payload.short_description, /Conheça Donzela/);
  assert.doesNotMatch(payload.short_description, /masculino|feminino|amadeirado/i);
});

test("descrição e categoria geradas pela IA não entram no rascunho", () => {
  const payload = buildAiProductDraftPayload(
    {
      name: "Donzela",
      short_description: "Perfume masculino amadeirado com longa fixação.",
      category: "Masculino",
    },
    { randomBytes: fixedRandomBytes }
  );

  assert.equal(payload.category, "");
  assert.doesNotMatch(payload.short_description, /masculino|amadeirado|fixação/i);
});

test("criação usa a permissão real products.create e master usa curinga", () => {
  const permissions = readSource("services/AI/permissions/modules.permissions.js");
  const tool = readSource("services/AI/tools/products.write.tool.js");

  assert.match(permissions, /products_create:\s*"products\.create"/);
  assert.match(permissions, /products_edit:\s*"products\.edit"/);
  assert.match(permissions, /products_delete:\s*"products\.delete"/);
  assert.doesNotMatch(permissions, /products\.manage/);
  assert.match(tool, /create:\s*"products\.create"/);
  assert.match(tool, /granted\.has\("\*"\)/);
});

test("resposta da criação oferece ação estruturada para abrir o editor", () => {
  const orchestrator = readSource("services/AI/orchestrator/index.js");

  assert.match(orchestrator, /type:\s*"open_product_editor"/);
  assert.match(orchestrator, /label:\s*"Abrir produto"/);
  assert.match(orchestrator, /productId:\s*String\(createdProduct\.id\)/);
  assert.match(orchestrator, /Produto criado como rascunho com sucesso/);
  assert.match(orchestrator, /extraia somente o nome comercial informado/);
  assert.doesNotMatch(orchestrator, /Fragrância amadeirada de presença elegante/);
  assert.doesNotMatch(orchestrator, /Detalhes:\s*\$\{JSON\.stringify\(toolResult/);
});

test("identidade usada na auditoria vem da sessão administrativa", () => {
  const controller = readSource("controllers/adminAi.controller.js");
  const orchestrator = readSource("services/AI/orchestrator/index.js");

  assert.match(controller, /user:\s*req\.admin,/);
  assert.doesNotMatch(controller, /req\.body\?\.user/);
  assert.match(orchestrator, /actor:\s*user\s*\|\|\s*\{\}/);
});
