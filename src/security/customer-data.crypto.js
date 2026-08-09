import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from "node:crypto";

const CIPHER_ALGORITHM = "aes-256-gcm";
const AUTH_TAG_LENGTH_BYTES = 16;
const IV_LENGTH_BYTES = 12;
const KEY_LENGTH_BYTES = 32;
const FORMAT_PREFIX = "ozc";
const CURRENT_VERSION = "v1";
const MAX_PLAINTEXT_BYTES = 16 * 1024;

const ENCRYPTION_KEY_ENV_BY_VERSION = Object.freeze({
  v1: "CUSTOMER_DATA_ENCRYPTION_KEY_V1",
});

const INDEX_KEY_ENV_BY_VERSION = Object.freeze({
  v1: "CUSTOMER_DATA_INDEX_KEY_V1",
});

const ALLOWED_FIELDS = new Set([
  "cpf",
  "email",
  "phone",
  "birth_date",
  "shipping_address",
  "shipping_number",
  "shipping_complement",
  "shipping_neighborhood",
  "shipping_city",
  "shipping_state",
  "shipping_cep",
]);

function cleanFieldName(field) {
  const normalized = String(field || "").trim().toLowerCase();

  if (!ALLOWED_FIELDS.has(normalized)) {
    throw new Error("Campo de dado sensível não suportado.");
  }

  return normalized;
}

function decodeKeyMaterial(rawValue, envName) {
  const raw = String(rawValue || "").trim();

  if (!raw) {
    throw new Error(`Configuração criptográfica ausente: ${envName}.`);
  }

  let decoded = null;

  if (/^[a-f0-9]{64}$/i.test(raw)) {
    decoded = Buffer.from(raw, "hex");
  } else {
    try {
      const normalized = raw.replace(/-/g, "+").replace(/_/g, "/");
      const padded =
        normalized + "=".repeat((4 - (normalized.length % 4 || 4)) % 4);
      decoded = Buffer.from(padded, "base64");
    } catch {
      decoded = null;
    }
  }

  if (!decoded || decoded.length !== KEY_LENGTH_BYTES) {
    throw new Error(
      `${envName} deve conter exatamente 32 bytes aleatórios em hexadecimal ou Base64.`
    );
  }

  return decoded;
}

function getVersionedKey(version, envMap) {
  const envName = envMap[version];

  if (!envName) {
    throw new Error("Versão de chave criptográfica não suportada.");
  }

  return decodeKeyMaterial(process.env[envName], envName);
}

function getEncryptionKey(version = CURRENT_VERSION) {
  return getVersionedKey(version, ENCRYPTION_KEY_ENV_BY_VERSION);
}

function getIndexKey(version = CURRENT_VERSION) {
  return getVersionedKey(version, INDEX_KEY_ENV_BY_VERSION);
}

function toBase64Url(buffer) {
  return Buffer.from(buffer).toString("base64url");
}

function fromBase64Url(value, label) {
  try {
    const decoded = Buffer.from(String(value || ""), "base64url");

    if (!decoded.length) {
      throw new Error("empty");
    }

    return decoded;
  } catch {
    throw new Error(`Payload criptográfico inválido (${label}).`);
  }
}

function buildAad(field, version) {
  return Buffer.from(
    `ozonteck:customer-data:${version}:${cleanFieldName(field)}`,
    "utf8"
  );
}

function stringifySensitiveValue(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const text = String(value).trim();

  if (!text) {
    return null;
  }

  if (Buffer.byteLength(text, "utf8") > MAX_PLAINTEXT_BYTES) {
    throw new Error("Dado sensível excede o tamanho máximo permitido.");
  }

  return text;
}

export function normalizeCustomerSensitiveValue(value, field) {
  const normalizedField = cleanFieldName(field);
  const text = stringifySensitiveValue(value);

  if (text === null) {
    return null;
  }

  switch (normalizedField) {
    case "cpf":
    case "phone":
    case "shipping_cep":
      return text.replace(/\D/g, "");

    case "email":
      return text.toLowerCase();

    case "birth_date": {
      const dateOnly = text.slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateOnly)) {
        throw new Error("Data de nascimento inválida para indexação.");
      }
      return dateOnly;
    }

    default:
      return text.replace(/\s+/g, " ").trim();
  }
}

export function encryptCustomerField(value, field, options = {}) {
  const plaintext = stringifySensitiveValue(value);

  if (plaintext === null) {
    return null;
  }

  const normalizedField = cleanFieldName(field);
  const version = String(options.version || CURRENT_VERSION).trim().toLowerCase();
  const key = getEncryptionKey(version);
  const iv = randomBytes(IV_LENGTH_BYTES);
  const aad = buildAad(normalizedField, version);

  const cipher = createCipheriv(CIPHER_ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH_BYTES,
  });

  cipher.setAAD(aad);

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);

  const authTag = cipher.getAuthTag();

  return [
    FORMAT_PREFIX,
    version,
    toBase64Url(iv),
    toBase64Url(ciphertext),
    toBase64Url(authTag),
  ].join(":");
}

export function decryptCustomerField(payload, field) {
  if (payload === null || payload === undefined || payload === "") {
    return null;
  }

  const normalizedField = cleanFieldName(field);
  const parts = String(payload).split(":");

  if (parts.length !== 5 || parts[0] !== FORMAT_PREFIX) {
    throw new Error("Payload criptográfico inválido.");
  }

  const [, version, ivPart, ciphertextPart, authTagPart] = parts;

  if (!ENCRYPTION_KEY_ENV_BY_VERSION[version]) {
    throw new Error("Versão de payload criptográfico não suportada.");
  }

  const iv = fromBase64Url(ivPart, "iv");
  const ciphertext = fromBase64Url(ciphertextPart, "ciphertext");
  const authTag = fromBase64Url(authTagPart, "authTag");

  if (iv.length !== IV_LENGTH_BYTES) {
    throw new Error("Payload criptográfico inválido (iv).");
  }

  if (authTag.length !== AUTH_TAG_LENGTH_BYTES) {
    throw new Error("Payload criptográfico inválido (authTag).");
  }

  const key = getEncryptionKey(version);
  const aad = buildAad(normalizedField, version);

  try {
    const decipher = createDecipheriv(CIPHER_ALGORITHM, key, iv, {
      authTagLength: AUTH_TAG_LENGTH_BYTES,
    });

    decipher.setAAD(aad);
    decipher.setAuthTag(authTag);

    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);

    return plaintext.toString("utf8");
  } catch {
    throw new Error("Não foi possível validar ou descriptografar o dado sensível.");
  }
}

export function createCustomerBlindIndex(value, field, options = {}) {
  const normalizedField = cleanFieldName(field);
  const normalizedValue = normalizeCustomerSensitiveValue(
    value,
    normalizedField
  );

  if (normalizedValue === null) {
    return null;
  }

  const version = String(options.version || CURRENT_VERSION).trim().toLowerCase();
  const key = getIndexKey(version);

  const domainSeparatedValue = [
    "ozonteck",
    "customer-index",
    version,
    normalizedField,
    normalizedValue,
  ].join("\u0000");

  const digest = createHmac("sha256", key)
    .update(domainSeparatedValue, "utf8")
    .digest("base64url");

  return `${version}:${digest}`;
}

export function isEncryptedCustomerField(value) {
  return /^ozc:v\d+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/.test(
    String(value || "")
  );
}

export function encryptCustomerCpf(value, options = {}) {
  const normalizedCpf = normalizeCustomerSensitiveValue(value, "cpf");

  if (normalizedCpf === null) {
    return null;
  }

  return encryptCustomerField(normalizedCpf, "cpf", options);
}

export function decryptCustomerCpf(payload) {
  return decryptCustomerField(payload, "cpf");
}

export function createCustomerCpfBlindIndex(value, options = {}) {
  return createCustomerBlindIndex(value, "cpf", options);
}
