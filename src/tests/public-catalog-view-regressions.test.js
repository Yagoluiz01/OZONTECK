import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  PUBLIC_CATALOG_PRODUCT_FIELDS,
  buildPublicCatalogPayload,
  compactPublicProductForCatalog,
  compactPublicProductsForCatalog,
} from "../utils/publicCatalogView.js";

const storeRoutesPath = fileURLToPath(
  new URL("../routes/store.routes.js", import.meta.url),
);

function createFullProduct() {
  return {
    id: "produto-1",
    sku: "SKU-1",
    slug: "produto-premium",
    name: "Produto Premium",
    category_id: "categoria-1",
    categoryId: "categoria-1",
    category: "Eletrônicos",
    shortDescription: "Descrição curta do produto",
    description: "Descrição curta do produto",
    imageUrl: "https://cdn.example.com/produto.webp",
    imageUrl2: "https://cdn.example.com/produto-2.webp",
    image_thumb_url: "https://cdn.example.com/produto-320.webp",
    imageThumbUrl: "https://cdn.example.com/produto-320.webp",
    image_detail_url: "https://cdn.example.com/produto-800.webp",
    imageDetailUrl: "https://cdn.example.com/produto-800.webp",
    image_srcset_thumb: "produto-320.webp 320w, produto-480.webp 480w",
    imageSrcsetThumb: "produto-320.webp 320w, produto-480.webp 480w",
    image_lqip: "data:image/webp;base64,AAAA",
    imageLqip: "data:image/webp;base64,AAAA",
    image_zoom_url: "https://cdn.example.com/produto-1200.webp",
    video_url: "https://cdn.example.com/produto.mp4",
    price: 199.9,
    compareAtPrice: 249.9,
    compare_at_price: 249.9,
    stockQuantity: 12,
    status: "active",
    installment_count: 12,
    installmentCount: 12,
    installment_value: 16.66,
    installmentValue: 16.66,
    installment_label: "12x de R$ 16,66",
    installmentLabel: "12x de R$ 16,66",
    payment_method_simulated: "credit_card",
    payment_fee_value: 4.5,
    payment_net_value: 195.4,
    variant_group: "grupo-1",
    variant_type: "kit",
    variant_label: "Kit completo",
    variant_order: 1,
    pricing_updated_at: "2026-08-24T12:00:00.000Z",
    smart_score: 1234,
    smartScore: 1234,
    weightKg: 1.2,
    heightCm: 10,
    widthCm: 20,
    lengthCm: 30,
    created_at: "2026-08-01T12:00:00.000Z",
    updated_at: "2026-08-24T12:00:00.000Z",
  };
}

test("visão compacta preserva todos os campos usados pelo catálogo", () => {
  const source = createFullProduct();
  const compact = compactPublicProductForCatalog(source);

  assert.deepEqual(Object.keys(compact), [...PUBLIC_CATALOG_PRODUCT_FIELDS]);
  assert.equal(compact.id, source.id);
  assert.equal(compact.name, source.name);
  assert.equal(compact.price, source.price);
  assert.equal(compact.stockQuantity, source.stockQuantity);
  assert.equal(compact.image_thumb_url, source.image_thumb_url);
  assert.equal(compact.installment_count, source.installment_count);
  assert.equal(compact.variant_group, source.variant_group);
});

test("visão compacta remove somente dados desnecessários ao catálogo", () => {
  const source = createFullProduct();
  const sourceCopy = structuredClone(source);
  const compact = compactPublicProductForCatalog(source);

  assert.equal("video_url" in compact, false);
  assert.equal("imageUrl2" in compact, false);
  assert.equal("image_zoom_url" in compact, false);
  assert.equal("smart_score" in compact, false);
  assert.equal("weightKg" in compact, false);
  assert.deepEqual(source, sourceCopy);

  const originalBytes = Buffer.byteLength(JSON.stringify(source));
  const compactBytes = Buffer.byteLength(JSON.stringify(compact));
  assert.ok(compactBytes < originalBytes * 0.7);
});

test("payload compacto mantém contrato success e products", () => {
  const products = compactPublicProductsForCatalog([
    createFullProduct(),
    { ...createFullProduct(), id: "produto-2", slug: "produto-2" },
  ]);
  const payload = JSON.parse(buildPublicCatalogPayload(products));

  assert.equal(payload.success, true);
  assert.equal(payload.products.length, 2);
  assert.equal(payload.products[0].id, "produto-1");
  assert.equal(payload.products[1].id, "produto-2");
});

test("rota antiga permanece padrão e compactação exige view catalog", () => {
  const source = fs.readFileSync(storeRoutesPath, "utf8");

  assert.match(source, /req\.query\.view/);
  assert.match(source, /catalogView \? snapshot\.catalogPayload : snapshot\.listPayload/);
  assert.match(source, /catalogView\s+\? snapshot\.catalogProducts\s+: snapshot\.rankedProducts/);
  assert.match(source, /snapshot\.listPayload/);
});
