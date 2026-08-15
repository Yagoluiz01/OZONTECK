import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(__filename), "..");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("leituras administrativas de afiliados exigem permissão explícita", () => {
  const source = read("routes/adminAffiliates.routes.js");

  assert.match(source, /requirePermission\("affiliates\.view"\)/);
  assert.match(
    source,
    /router\.get\("\/applications", requirePermission\("affiliates\.view"\)/
  );
  assert.match(
    source,
    /router\.get\("\/:id", requirePermission\("affiliates\.view"\)/
  );
  assert.match(
    source,
    /router\.get\("\/:id\/payouts", requirePermission\("affiliates\.view"\)/
  );
});

test("criação, alteração e aprovação de afiliados exigem master", () => {
  const source = read("routes/adminAffiliates.routes.js");

  assert.match(
    source,
    /router\.post\("\/applications\/:id\/approve", requireMasterAdmin/
  );
  assert.match(
    source,
    /router\.post\("\/applications\/:id\/reject", requireMasterAdmin/
  );
  assert.match(source, /router\.post\("\/", requireMasterAdmin/);
  assert.match(source, /router\.patch\("\/:id", requireMasterAdmin/);
});

test("metas exigem a permissão affiliates.goals", () => {
  const source = read("routes/adminAffiliates.routes.js");

  assert.match(
    source,
    /router\.post\("\/:id\/process-level-progress", requirePermission\("affiliates\.goals"\)/
  );
});

test("respostas administrativas removem credenciais recursivamente", () => {
  const source = read("routes/adminAffiliates.routes.js");

  assert.match(source, /SENSITIVE_RESPONSE_KEYS/);
  assert.match(source, /"password_hash"/);
  assert.match(source, /\.filter\(\(\[key\]\) => !SENSITIVE_RESPONSE_KEYS\.has\(key\)\)/);
  assert.match(source, /\.\.\.sanitizeResponseData\(data\)/);
});

test("API administrativa não aceita password_hash fornecido pelo cliente", () => {
  const source = read("services/adminAffiliates.service.js");

  assert.match(source, /\{ allowPasswordHash = false \} = \{\}/);
  assert.match(source, /const passwordHash = allowPasswordHash/);
  assert.match(source, /if \(allowPasswordHash && \(!isUpdate \|\| passwordHash\)\)/);
  assert.match(
    source,
    /export async function updateAffiliate\(id, input = \{\}\)[\s\S]{0,500}buildAffiliatePayload\(input, true\)/
  );
});

test("atualização parcial não ativa afiliado por padrão", () => {
  const source = read("services/adminAffiliates.service.js");

  assert.match(
    source,
    /const hasStatus = Object\.prototype\.hasOwnProperty\.call\(input, "status"\)/
  );
  assert.match(source, /if \(!isUpdate\) \{[\s\S]{0,100}payload\.status = status \|\| "active"/);
  assert.match(source, /else if \(hasStatus\) \{[\s\S]{0,80}payload\.status = status/);
  assert.doesNotMatch(source, /cleanText\(input\.status \|\| "active"\)/);
});

test("somente aprovação interna transfere o hash já criado na inscrição", () => {
  const source = read("services/adminAffiliates.service.js");

  const trustedCalls =
    source.match(/\{ allowPasswordHash: true \}/g) || [];

  assert.equal(trustedCalls.length, 1);
  assert.match(
    source,
    /skipAffiliateCreatedNotification: true,[\s\S]{0,100}\{ allowPasswordHash: true \}/
  );
});

test("serviço remove hashes das respostas de afiliados e solicitações", () => {
  const source = read("services/adminAffiliates.service.js");

  assert.match(source, /sanitizeAffiliateResponseRecord/);
  assert.match(source, /sanitizeAffiliateResponseRows/);
  assert.match(
    source,
    /return sanitizeAffiliateResponseRecord\(updated\?\.\[0\] \|\| null\)/
  );
});
