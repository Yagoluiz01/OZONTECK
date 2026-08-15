function normalizeStatus(value, fallback = 500) {
  const candidate = Number(value || fallback);

  if (!Number.isInteger(candidate) || candidate < 400 || candidate > 599) {
    return 500;
  }

  return candidate;
}

export function buildPublicApiError(error, options = {}) {
  const fallbackMessage = String(options.fallbackMessage || "Erro interno.");
  const status = normalizeStatus(
    error?.statusCode || error?.status,
    options.defaultStatus || 500
  );
  const publicMessage = status >= 500 || error?.expose === false
    ? fallbackMessage
    : String(error?.message || fallbackMessage);

  return {
    status,
    body: {
      success: false,
      message: publicMessage,
    },
  };
}
