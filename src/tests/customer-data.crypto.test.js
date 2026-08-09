import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import {
  createCustomerBlindIndex,
  createCustomerCpfBlindIndex,
  decryptCustomerCpf,
  decryptCustomerField,
  encryptCustomerCpf,
  encryptCustomerField,
  isEncryptedCustomerField,
} from "../security/customer-data.crypto.js";

const ORIGINAL_ENCRYPTION_KEY = process.env.CUSTOMER_DATA_ENCRYPTION_KEY_V1;
const ORIGINAL_INDEX_KEY = process.env.CUSTOMER_DATA_INDEX_KEY_V1;

function installTemporaryKeys() {
  process.env.CUSTOMER_DATA_ENCRYPTION_KEY_V1 = randomBytes(32).toString("base64");
  process.env.CUSTOMER_DATA_INDEX_KEY_V1 = randomBytes(32).toString("base64");
}

function restoreKeys() {
  if (ORIGINAL_ENCRYPTION_KEY === undefined) {
    delete process.env.CUSTOMER_DATA_ENCRYPTION_KEY_V1;
  } else {
    process.env.CUSTOMER_DATA_ENCRYPTION_KEY_V1 = ORIGINAL_ENCRYPTION_KEY;
  }

  if (ORIGINAL_INDEX_KEY === undefined) {
    delete process.env.CUSTOMER_DATA_INDEX_KEY_V1;
  } else {
    process.env.CUSTOMER_DATA_INDEX_KEY_V1 = ORIGINAL_INDEX_KEY;
  }
}

test.before(installTemporaryKeys);
test.after(restoreKeys);

test("CPF faz round-trip sem perder o valor normalizado", () => {
  const encrypted = encryptCustomerCpf("123.456.789-09");
  assert.equal(isEncryptedCustomerField(encrypted), true);
  assert.equal(decryptCustomerCpf(encrypted), "12345678909");
});

test("mesmo CPF gera ciphertext diferente por causa do IV aleatório", () => {
  const first = encryptCustomerCpf("123.456.789-09");
  const second = encryptCustomerCpf("123.456.789-09");
  assert.notEqual(first, second);
  assert.equal(decryptCustomerCpf(first), "12345678909");
  assert.equal(decryptCustomerCpf(second), "12345678909");
});

test("mesmo CPF normalizado gera o mesmo blind index", () => {
  const formatted = createCustomerCpfBlindIndex("123.456.789-09");
  const digitsOnly = createCustomerCpfBlindIndex("12345678909");
  assert.equal(formatted, digitsOnly);
  assert.match(formatted, /^v1:[A-Za-z0-9_-]+$/);
});

test("blind index é separado por domínio/campo", () => {
  const value = "11999999999";
  const phoneIndex = createCustomerBlindIndex(value, "phone");
  const cpfIndex = createCustomerBlindIndex(value, "cpf");
  assert.notEqual(phoneIndex, cpfIndex);
});

test("trocar o campo de contexto impede descriptografia", () => {
  const encrypted = encryptCustomerField("cliente@example.com", "email");
  assert.throws(
    () => decryptCustomerField(encrypted, "phone"),
    /Não foi possível validar ou descriptografar/
  );
});

test("adulterar o ciphertext é detectado pelo GCM", () => {
  const encrypted = encryptCustomerCpf("123.456.789-09");
  const parts = encrypted.split(":");
  const ciphertext = Buffer.from(parts[3], "base64url");
  ciphertext[0] ^= 0x01;
  parts[3] = ciphertext.toString("base64url");
  assert.throws(
    () => decryptCustomerCpf(parts.join(":")),
    /Não foi possível validar ou descriptografar/
  );
});

test("chave ausente falha somente quando a função é usada", () => {
  const current = process.env.CUSTOMER_DATA_ENCRYPTION_KEY_V1;
  delete process.env.CUSTOMER_DATA_ENCRYPTION_KEY_V1;
  try {
    assert.throws(
      () => encryptCustomerCpf("12345678909"),
      /CUSTOMER_DATA_ENCRYPTION_KEY_V1/
    );
  } finally {
    process.env.CUSTOMER_DATA_ENCRYPTION_KEY_V1 = current;
  }
});

test("chaves de tamanho incorreto são rejeitadas", () => {
  const current = process.env.CUSTOMER_DATA_ENCRYPTION_KEY_V1;
  process.env.CUSTOMER_DATA_ENCRYPTION_KEY_V1 =
    Buffer.from("curta").toString("base64");
  try {
    assert.throws(
      () => encryptCustomerCpf("12345678909"),
      /exatamente 32 bytes/
    );
  } finally {
    process.env.CUSTOMER_DATA_ENCRYPTION_KEY_V1 = current;
  }
});
