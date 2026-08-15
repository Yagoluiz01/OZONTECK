import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildTrustedShippingQuoteSnapshot } from "../utils/shippingQuoteSnapshot.js";

const __filename = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(__filename), "..");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("pedido preserva o pacote confiável retornado pela cotação", () => {
  const snapshot = buildTrustedShippingQuoteSnapshot({
    provider: "melhor_envio",
    quote: {
      carrier: "Jadlog",
      serviceCode: "3",
      serviceName: ".Package",
      price: 28.85,
      deliveryTime: 5,
      raw: {
        id: 3,
        packages: [
          {
            format: "box",
            weight: "0.60",
            dimensions: { height: 8, width: 16, length: 16 },
            products: [{ id: "produto-1", quantity: 2 }]
          }
        ]
      }
    },
    fallbackPackage: {
      weightKg: 99,
      heightCm: 99,
      widthCm: 99,
      lengthCm: 99
    }
  });

  assert.equal(snapshot.verified_provider, "melhor_envio");
  assert.equal(snapshot.verified_service_code, "3");
  assert.deepEqual(snapshot.packages, [
    {
      id: "volume-1",
      format: "box",
      weight: 0.6,
      dimensions: { width: 16, height: 8, length: 16 },
      products: [{ id: "produto-1", quantity: 2 }]
    }
  ]);
});

test("pacote calculado pela API é usado quando o provedor não devolve volumes", () => {
  const snapshot = buildTrustedShippingQuoteSnapshot({
    provider: "frenet",
    quote: {
      carrier: "Transportadora",
      serviceCode: "10",
      serviceName: "Expresso",
      price: 40,
      deliveryTime: 3,
      raw: { ServiceCode: "10" }
    },
    fallbackPackage: {
      weightKg: 0.6,
      heightCm: 16,
      widthCm: 8,
      lengthCm: 16
    }
  });

  assert.deepEqual(snapshot.packages, [
    {
      id: "volume-1",
      format: "box",
      weight: 0.6,
      dimensions: { width: 8, height: 16, length: 16 },
      products: []
    }
  ]);
});

test("checkout salva somente transportadora, serviço e pacote revalidados no servidor", () => {
  const source = read("routes/store.routes.js");

  assert.match(
    source,
    /shipping_carrier:\s*String\(validatedShippingQuote\.carrier/
  );
  assert.match(
    source,
    /shipping_service_name:\s*String\(validatedShippingQuote\.serviceName/
  );
  assert.match(
    source,
    /shipping_quote_raw:\s*buildShippingQuoteRawForOrder\(validatedShipping\)/
  );
  assert.doesNotMatch(
    source,
    /shipping_quote_raw:\s*buildShippingQuoteRawForOrder\(selectedShipping\)/
  );
});

test("fallback da etiqueta multiplica peso e comprimento pela quantidade", () => {
  const source = read("services/shipping.service.js");

  assert.match(
    source,
    /toNumber\(item\?\.length[\s\S]{0,160}\* getItemQuantity\(item\)/
  );
  assert.match(
    source,
    /toNumber\(item\?\.weight[\s\S]{0,180}\* getItemQuantity\(item\)/
  );
});
