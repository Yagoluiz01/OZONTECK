import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { toPublicAffiliateApplication } from "../utils/publicAffiliateApplication.js";

const storeRoutesSource = fs.readFileSync(
  new URL("../routes/store.routes.js", import.meta.url),
  "utf8"
);

const forbiddenKeys = new Set([
  "password",
  "password_hash",
  "passwordHash",
  "pix_key",
  "pixKey",
  "phone",
  "email",
  "admin_notes",
  "token",
  "token_hash",
  "recruiter_affiliate_id",
]);

function collectKeys(value, keys = new Set()) {
  if (!value || typeof value !== "object") return keys;

  for (const [key, nested] of Object.entries(value)) {
    keys.add(key);
    collectKeys(nested, keys);
  }

  return keys;
}

test("resposta pública da inscrição usa uma lista positiva mínima", () => {
  const result = toPublicAffiliateApplication({
    id: "app-123",
    status: "pending",
    created_at: "2026-08-15T12:00:00.000Z",
    full_name: "Nome privado",
    email: "privado@example.com",
    phone: "71999999999",
    pix_key: "71999999999",
    password_hash: "$2b$10$hash-privado",
    admin_notes: "anotação interna",
    recruiter_affiliate_id: "affiliate-123",
    metadata: {
      token_hash: "token-privado",
    },
  });

  assert.deepEqual(result, {
    id: "app-123",
    status: "pending",
    created_at: "2026-08-15T12:00:00.000Z",
  });

  const returnedKeys = collectKeys(result);
  for (const key of forbiddenKeys) {
    assert.equal(returnedKeys.has(key), false, `campo proibido exposto: ${key}`);
  }
});

test("status desconhecido falha fechado como pending", () => {
  const result = toPublicAffiliateApplication({
    id: "app-456",
    status: "internal_review_with_fraud_signal",
  });

  assert.equal(result.status, "pending");
});

test("rota pública de inscrição não revela se cadastro já existia", () => {
  const routeBlock = storeRoutesSource.slice(
    storeRoutesSource.indexOf('router.post("/affiliates/apply"'),
    storeRoutesSource.indexOf('router.get("/health"')
  );

  assert.match(routeBlock, /status\(202\)/);
  assert.match(routeBlock, /accepted:\s*true/);
  assert.doesNotMatch(routeBlock, /alreadyExists/);
  assert.doesNotMatch(routeBlock, /application:/);
  assert.doesNotMatch(routeBlock, /toPublicAffiliateApplication/);
});
