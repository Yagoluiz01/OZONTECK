function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeToken(value) {
  return normalizeText(value).replace(/\s+/g, "_");
}

/**
 * Taxonomia compartilhada pelo ranking da loja e pelas notificações.
 * Alterar este mapa muda os dois fluxos e, por isso, exige teste de regressão.
 */
export function normalizeInterestCategory(value) {
  const text = normalizeText(value);

  if (!text) return "";

  if (/\bunissex\b|\bunisex\b/.test(text)) return "perfumes_unissex";
  if (/\bmasculin/.test(text)) return "perfumes_masculinos";
  if (/\bfeminin/.test(text)) return "perfumes_femininos";
  if (/\bcabelo/.test(text) || /\bcapilar/.test(text)) return "cabelos";
  if (/\bpele\b/.test(text) || /\bskincare\b/.test(text)) return "cuidados_pele";

  return (
    text
      .replace(/\bperfumes?\b/g, " ")
      .replace(/\bfragrancias?\b/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/\s+/g, "_") || normalizeToken(value)
  );
}

export function getInterestCategoryFamily(categoryToken) {
  const normalized = String(categoryToken || "");
  return normalized.startsWith("perfumes_") ? "perfumes" : normalized;
}
