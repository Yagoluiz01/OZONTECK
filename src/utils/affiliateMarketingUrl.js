const MAX_MARKETING_URL_LENGTH = 2048;

function invalidUrlError(fieldName) {
  const error = new Error(`${fieldName} deve ser uma URL HTTPS válida.`);
  error.statusCode = 400;
  error.code = "INVALID_AFFILIATE_MARKETING_URL";
  return error;
}

export function sanitizeOptionalHttpsUrl(value, fieldName = "url") {
  if (value === undefined) return undefined;
  if (value === null) return null;

  const raw = String(value).trim();
  if (!raw) return null;

  if (raw.length > MAX_MARKETING_URL_LENGTH) {
    throw invalidUrlError(fieldName);
  }

  let parsed;

  try {
    parsed = new URL(raw);
  } catch {
    throw invalidUrlError(fieldName);
  }

  if (
    parsed.protocol !== "https:" ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password
  ) {
    throw invalidUrlError(fieldName);
  }

  return parsed.toString();
}

export function sanitizeHttpsUrlFields(payload = {}, fields = []) {
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(payload, field)) continue;
    payload[field] = sanitizeOptionalHttpsUrl(payload[field], field);
  }

  return payload;
}
