function toPositiveNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function normalizeProducts(products = []) {
  if (!Array.isArray(products)) return [];

  return products
    .map((product) => {
      const id = String(product?.id || "").trim();
      const quantity = Math.max(1, Math.trunc(Number(product?.quantity || 1) || 1));

      return id ? { id, quantity } : null;
    })
    .filter(Boolean);
}

function normalizeProviderPackage(pkg, index) {
  const width = toPositiveNumber(pkg?.width ?? pkg?.dimensions?.width);
  const height = toPositiveNumber(pkg?.height ?? pkg?.dimensions?.height);
  const length = toPositiveNumber(pkg?.length ?? pkg?.dimensions?.length);
  const weight = toPositiveNumber(pkg?.weight);

  if (!width || !height || !length || !weight) return null;

  return {
    id: String(pkg?.id || `volume-${index + 1}`),
    format: String(pkg?.format || "box"),
    weight,
    dimensions: {
      width,
      height,
      length
    },
    products: normalizeProducts(pkg?.products)
  };
}

function normalizeFallbackPackage(pkg) {
  if (!pkg || typeof pkg !== "object") return null;

  return normalizeProviderPackage(
    {
      id: "volume-1",
      format: "box",
      width: pkg.widthCm,
      height: pkg.heightCm,
      length: pkg.lengthCm,
      weight: pkg.weightKg
    },
    0
  );
}

export function buildTrustedShippingQuoteSnapshot({
  provider,
  quote,
  fallbackPackage
} = {}) {
  const trustedQuote = quote && typeof quote === "object" ? quote : {};
  const raw =
    trustedQuote.raw && typeof trustedQuote.raw === "object"
      ? trustedQuote.raw
      : {};

  const providerPackages = Array.isArray(raw.packages)
    ? raw.packages.map(normalizeProviderPackage).filter(Boolean)
    : [];

  const fallback = normalizeFallbackPackage(fallbackPackage);
  const packages = providerPackages.length
    ? providerPackages
    : fallback
      ? [fallback]
      : [];

  return {
    ...raw,
    packages,
    verified_provider: String(provider || "").trim(),
    verified_service_code: String(trustedQuote.serviceCode || "").trim(),
    verified_service_name: String(trustedQuote.serviceName || "").trim(),
    verified_carrier: String(trustedQuote.carrier || "").trim(),
    verified_price: Number(trustedQuote.price || 0) || 0,
    verified_delivery_time: Number(trustedQuote.deliveryTime || 0) || 0
  };
}
