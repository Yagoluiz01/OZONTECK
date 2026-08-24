import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  PUBLIC_PRODUCT_SELECT_FIELDS,
  buildPublicProductsUrl,
} from "../utils/publicProductProjection.js";

const storeRoutesPath = fileURLToPath(
  new URL("../routes/store.routes.js", import.meta.url),
);

test("consulta pública seleciona somente os campos necessários", () => {
  const requiredFields = [
    "id",
    "name",
    "price",
    "stock_quantity",
    "status",
    "image_url",
    "short_description",
    "installment_count",
    "weight_kg",
    "created_at",
  ];

  for (const field of requiredFields) {
    assert.ok(
      PUBLIC_PRODUCT_SELECT_FIELDS.includes(field),
      `campo público ausente: ${field}`,
    );
  }

  assert.equal(new Set(PUBLIC_PRODUCT_SELECT_FIELDS).size, PUBLIC_PRODUCT_SELECT_FIELDS.length);

  const url = new URL(buildPublicProductsUrl("https://example.supabase.co/"));
  assert.equal(url.pathname, "/rest/v1/products");
  assert.equal(url.searchParams.get("select"), PUBLIC_PRODUCT_SELECT_FIELDS.join(","));
  assert.notEqual(url.searchParams.get("select"), "*");
});

test("consulta pública não transfere custos internos do produto", () => {
  const privateFields = [
    "cost_price",
    "gateway_fee_percent",
    "tax_percent",
    "packaging_cost",
    "traffic_cost",
    "other_costs",
    "unit_profit",
    "minimum_price",
    "suggested_price",
    "promotional_min_price",
    "desired_margin_percent",
    "average_shipping_cost",
    "image_hash",
  ];

  for (const field of privateFields) {
    assert.equal(
      PUBLIC_PRODUCT_SELECT_FIELDS.includes(field),
      false,
      `campo interno exposto na leitura pública: ${field}`,
    );
  }
});

test("rota de produtos usa a projeção pública centralizada", () => {
  const source = fs.readFileSync(storeRoutesPath, "utf8");

  assert.match(source, /buildPublicProductsUrl\(env\.supabaseUrl\)/);
  assert.doesNotMatch(source, /rest\/v1\/products\?select=\*/);
});
