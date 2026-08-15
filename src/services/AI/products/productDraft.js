import crypto from "node:crypto";

function normalizeText(value, maxLength) {
  return String(value || "")
    .replace(/\0/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function slugifySku(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24) || "PRODUTO";
}

function buildNeutralDraftDescription(name) {
  return [
    `✨ Conheça ${name} e transforme sua escolha em um momento especial.`,
    "💫 Um convite para expressar seu estilo por meio da perfumaria.",
    "💚 Escolha com confiança e leve para sua coleção um perfume para chamar de seu.",
  ].join("\n");
}

export function buildAiProductDraftPayload(
  input = {},
  { randomBytes = crypto.randomBytes } = {}
) {
  const name = normalizeText(input.name, 160);

  if (!name) {
    const error = new Error("O nome do produto não foi gerado.");
    error.statusCode = 400;
    throw error;
  }

  const requestedSku = normalizeText(input.sku, 60)
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, "");
  const generatedSuffix = randomBytes(4).toString("hex").toUpperCase();

  return {
    name,
    sku: requestedSku || `${slugifySku(name)}-${generatedSuffix}`,
    category: "",
    short_description: buildNeutralDraftDescription(name),
    price: 0,
    compare_at_price: 0,
    stock_quantity: 0,
    status: "draft",
    show_on_home: false,
    image_url: "",
    image_url_2: "",
  };
}
