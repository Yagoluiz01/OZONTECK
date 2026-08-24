import {
  getInterestCategoryFamily,
  normalizeInterestCategory,
} from "./interestTaxonomy.js";

const PRODUCT_EVENT_TYPES = new Set([
  "product_view",
  "product_detail_view",
  "add_to_cart",
  "product_add_confirmed",
  "buy_now_confirmed",
]);

function safeJsonParse(value) {
  try {
    const parsed = JSON.parse(String(value || ""));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function cleanText(value, maxLength = 180) {
  const text = String(value || "").trim();
  return text ? text.slice(0, maxLength) : "";
}

function normalizeToken(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

function toNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round(value, decimals = 2) {
  const power = 10 ** decimals;
  return Math.round((Number(value) || 0) * power) / power;
}

function isActiveAvailableProduct(product = {}) {
  const status = String(product?.status || "").trim().toLowerCase();
  const stock = toNumber(product?.stock_quantity ?? product?.stockQuantity, 0);
  const explicitActive = product?.is_active ?? product?.isActive;

  if (["inactive", "inativo", "draft", "rascunho", "archived", "arquivado", "deleted"].includes(status)) {
    return false;
  }

  if (explicitActive === false || explicitActive === 0 || explicitActive === "0") return false;
  if (status && status !== "active" && status !== "ativo") return false;
  return stock > 0;
}

export function normalizeRecommendationProduct(product = {}) {
  const id = cleanText(product?.id);
  const name = cleanText(product?.name || product?.nome);
  const sku = cleanText(product?.sku);
  const slug = cleanText(product?.slug || sku || name || id);
  const category = cleanText(product?.category || product?.categoria);
  const price = toNumber(product?.price ?? product?.preco, 0);
  const compareAtPrice = toNumber(product?.compare_at_price ?? product?.compareAtPrice, 0);
  const stockQuantity = toNumber(product?.stock_quantity ?? product?.stockQuantity, 0);
  const imageUrl = cleanText(
    product?.image_card_url ||
      product?.imageCardUrl ||
      product?.image_thumb_url ||
      product?.imageThumbUrl ||
      product?.image_url ||
      product?.imageUrl,
    500
  );

  return {
    raw: product,
    id,
    name,
    sku,
    slug,
    category,
    price,
    compareAtPrice,
    stockQuantity,
    imageUrl,
    shortDescription: cleanText(
      product?.short_description || product?.shortDescription || product?.description,
      260
    ),
    showOnHome: Boolean(product?.show_on_home ?? product?.showOnHome ?? false),
    available: Boolean(id && name && price > 0 && isActiveAvailableProduct(product)),
  };
}

function buildCatalogAliasMap(products = []) {
  const candidates = new Map();

  for (const product of products) {
    const tokens = new Set(
      [product.id, product.name, product.slug, product.sku]
        .map(normalizeToken)
        .filter(Boolean)
    );

    for (const token of tokens) {
      const ids = candidates.get(token) || new Set();
      ids.add(product.id);
      candidates.set(token, ids);
    }
  }

  const aliases = new Map();
  for (const [token, ids] of candidates.entries()) {
    if (ids.size === 1) aliases.set(token, Array.from(ids)[0]);
  }
  return aliases;
}

function resolveCatalogProductId(metadata = {}, aliases = new Map()) {
  const candidates = [
    metadata.product_id,
    metadata.productId,
    metadata.product_name,
    metadata.productName,
    metadata.slug,
    metadata.sku,
  ];

  for (const candidate of candidates) {
    const token = normalizeToken(candidate);
    if (token && aliases.has(token)) return aliases.get(token);
  }
  return "";
}

export function buildProductPerformance(events = [], catalogProducts = []) {
  const aliases = buildCatalogAliasMap(catalogProducts);
  const stats = new Map();

  function getRow(productId) {
    if (!stats.has(productId)) {
      stats.set(productId, {
        product_id: productId,
        raw_events: 0,
        detail_visitors: new Set(),
        view_visitors: new Set(),
        cart_visitors: new Set(),
        buy_now_visitors: new Set(),
      });
    }
    return stats.get(productId);
  }

  for (const event of Array.isArray(events) ? events : []) {
    const eventType = String(event?.event_type || "").trim();
    if (!PRODUCT_EVENT_TYPES.has(eventType)) continue;

    const metadata = safeJsonParse(event?.section);
    const productId = resolveCatalogProductId(metadata, aliases);
    if (!productId) continue;

    const actor = cleanText(event?.visitor_id || event?.session_id, 180) || `event:${event?.created_at || ""}`;
    const row = getRow(productId);
    row.raw_events += 1;

    if (eventType === "product_view") row.view_visitors.add(actor);
    if (eventType === "product_detail_view") row.detail_visitors.add(actor);
    if (eventType === "add_to_cart" || eventType === "product_add_confirmed") row.cart_visitors.add(actor);
    if (eventType === "buy_now_confirmed") row.buy_now_visitors.add(actor);
  }

  const result = new Map();
  for (const [productId, row] of stats.entries()) {
    const detailVisitors = row.detail_visitors.size;
    const viewVisitors = row.view_visitors.size;
    const cartVisitors = row.cart_visitors.size;
    const buyNowVisitors = row.buy_now_visitors.size;
    const denominator = Math.max(1, detailVisitors || viewVisitors);

    // Taxa suavizada para não premiar amostras minúsculas.
    const smoothedCartRate = (cartVisitors + 1.2) / (denominator + 10);
    const smoothedBuyRate = (buyNowVisitors + 0.6) / (denominator + 12);

    result.set(productId, {
      product_id: productId,
      raw_events: row.raw_events,
      view_visitors: viewVisitors,
      detail_visitors: detailVisitors,
      cart_visitors: cartVisitors,
      buy_now_visitors: buyNowVisitors,
      cart_rate_proxy: round(smoothedCartRate, 4),
      buy_now_rate_proxy: round(smoothedBuyRate, 4),
    });
  }

  return result;
}

function normalizeProfileProductMap(profile = {}) {
  const map = new Map();
  const rows = Array.isArray(profile?.top_products) ? profile.top_products : [];
  const maxScore = Math.max(1, ...rows.map((row) => toNumber(row?.score, 0)));

  for (const row of rows) {
    const idToken = normalizeToken(row?.id);
    const nameToken = normalizeToken(row?.name);
    const value = clamp(toNumber(row?.score, 0) / maxScore, 0, 1);
    if (idToken) map.set(idToken, Math.max(map.get(idToken) || 0, value));
    if (nameToken) map.set(nameToken, Math.max(map.get(nameToken) || 0, value));
  }
  return map;
}

function normalizeProfileCategoryMap(profile = {}) {
  const rows = Array.isArray(profile?.top_categories) ? profile.top_categories : [];
  const maxScore = Math.max(1, ...rows.map((row) => toNumber(row?.score, 0)));
  const map = new Map();

  for (const row of rows) {
    const token = normalizeInterestCategory(row?.name || row?.category || row?.id);
    if (!token) continue;
    const ratio = clamp(toNumber(row?.score, 0) / maxScore, 0, 1);
    map.set(token, Math.max(map.get(token) || 0, ratio));
  }
  return map;
}

function getDominantCategory(profileCategories = new Map()) {
  let key = "";
  let strength = 0;
  for (const [category, ratio] of profileCategories.entries()) {
    if (ratio > strength) {
      key = category;
      strength = ratio;
    }
  }
  return { key, strength };
}

function categoryCompatibilityPenalty({
  productCategory,
  profileCategories,
  intentConfidence,
}) {
  const productToken = normalizeInterestCategory(productCategory);
  const directAffinity = productToken ? profileCategories.get(productToken) || 0 : 0;
  if (directAffinity > 0) {
    return { penalty: 0, dominant: getDominantCategory(profileCategories), productToken };
  }

  const dominant = getDominantCategory(profileCategories);
  if (!productToken || !dominant.key || dominant.strength < 0.55 || intentConfidence < 30) {
    return { penalty: 0, dominant, productToken };
  }

  const confidenceFactor = clamp(intentConfidence / 100, 0.3, 1);
  const sameFamily =
    getInterestCategoryFamily(productToken) === getInterestCategoryFamily(dominant.key);
  const basePenalty = sameFamily ? 14 : 18;
  const penalty = basePenalty * dominant.strength * (0.55 + confidenceFactor * 0.45);

  return {
    penalty: clamp(penalty, 0, sameFamily ? 14 : 18),
    dominant,
    productToken,
  };
}

function explorationScore({ previouslyViewed, intentConfidence }) {
  if (previouslyViewed) return 0;

  // Exploração existe para evitar uma vitrine fechada, mas cai conforme o motor
  // ganha confiança sobre o gosto do cliente. Nunca domina afinidade/categoria.
  const confidence = clamp(toNumber(intentConfidence, 0), 0, 100);
  return clamp(2.8 - confidence * 0.022, 0.55, 2.8);
}

function performanceComponent(perf = {}, maxDetailVisitors = 1) {
  const detailVisitors = toNumber(perf?.detail_visitors, 0);
  const cartRate = clamp(toNumber(perf?.cart_rate_proxy, 0), 0, 1);
  const buyRate = clamp(toNumber(perf?.buy_now_rate_proxy, 0), 0, 1);

  const popularity = maxDetailVisitors > 0
    ? 8 * (Math.log1p(detailVisitors) / Math.log1p(Math.max(1, maxDetailVisitors)))
    : 0;
  const conversion = clamp(cartRate / 0.32, 0, 1) * 8 + clamp(buyRate / 0.16, 0, 1) * 4;

  return {
    popularity: clamp(popularity, 0, 8),
    performance: clamp(conversion, 0, 12),
  };
}

function stockScore(stockQuantity) {
  if (stockQuantity <= 0) return 0;
  if (stockQuantity <= 2) return 1.5;
  if (stockQuantity <= 5) return 2.5;
  if (stockQuantity <= 15) return 3.5;
  return 4;
}

function buildReasons({
  categoryScore,
  productAffinity,
  performance,
  popularity,
  previouslyViewed,
  exploration,
}) {
  const reasons = [];
  if (productAffinity >= 8 || previouslyViewed) reasons.push("afinidade_produto");
  if (categoryScore >= 10) reasons.push("categoria_preferida");
  if (performance >= 6) reasons.push("boa_resposta_de_compra");
  if (popularity >= 4.5) reasons.push("interesse_real_da_loja");
  if (exploration >= 1.8) reasons.push("descoberta_controlada");
  return reasons.slice(0, 4);
}

function normalizeCommercialScores(products, commercialScoreFn) {
  const scored = products.map((product) => ({
    id: product.id,
    raw: typeof commercialScoreFn === "function" ? toNumber(commercialScoreFn(product.raw), 0) : 0,
  }));

  const values = scored.map((row) => row.raw).filter(Number.isFinite);
  const min = values.length ? Math.min(...values) : 0;
  const max = values.length ? Math.max(...values) : 0;
  const range = Math.max(1, max - min);
  const map = new Map();

  for (const row of scored) {
    const normalized = max === min ? 0.5 : clamp((row.raw - min) / range, 0, 1);
    map.set(row.id, normalized);
  }
  return map;
}

export function buildPersonalizedRanking({
  profile = {},
  products = [],
  performanceByProduct = new Map(),
  commercialScoreFn = null,
  excludeProductId = "",
  limit = 8,
} = {}) {
  const catalog = (Array.isArray(products) ? products : [])
    .map(normalizeRecommendationProduct)
    .filter((product) => product.available);

  const excluded = normalizeToken(excludeProductId);
  const profileProducts = normalizeProfileProductMap(profile);
  const profileCategories = normalizeProfileCategoryMap(profile);
  const commercial = normalizeCommercialScores(catalog, commercialScoreFn);
  const maxDetailVisitors = Math.max(
    1,
    ...catalog.map((product) => toNumber(performanceByProduct.get(product.id)?.detail_visitors, 0))
  );

  const intentScore = clamp(toNumber(profile?.score, 0), 0, 100);
  const intentConfidence = clamp(toNumber(profile?.confidence, 0), 0, 100);
  const stageRank = toNumber(profile?.stage?.rank, 0);
  const familiarityMultiplier = stageRank >= 3 ? 1.12 : stageRank >= 2 ? 1.06 : 1;

  const candidates = [];

  for (const product of catalog) {
    if (excluded && [product.id, product.slug, product.name].some((value) => normalizeToken(value) === excluded)) {
      continue;
    }

    const idAffinity = profileProducts.get(normalizeToken(product.id)) || 0;
    const nameAffinity = profileProducts.get(normalizeToken(product.name)) || 0;
    const productAffinityRatio = Math.max(idAffinity, nameAffinity);
    const previouslyViewed = productAffinityRatio > 0;
    const productAffinity = 30 * productAffinityRatio * familiarityMultiplier;

    const canonicalCategory = normalizeInterestCategory(product.category);
    const categoryRatio = profileCategories.get(canonicalCategory) || 0;
    const categoryScore = 34 * categoryRatio;
    const categoryCompatibility = categoryCompatibilityPenalty({
      productCategory: product.category,
      profileCategories,
      intentConfidence,
    });

    const perf = performanceByProduct.get(product.id) || {};
    const perfComponents = performanceComponent(perf, maxDetailVisitors);
    const commercialScore = 6 * (commercial.get(product.id) || 0);
    const stock = Math.min(3, stockScore(product.stockQuantity));
    const exploration = explorationScore({ previouslyViewed, intentConfidence });

    // Preferência de preço está deliberadamente DESATIVADA nesta versão.
    // O catálogo ainda é pequeno; usar preço agora reduziria descoberta e criaria
    // uma falsa segmentação antes de existir variedade suficiente.
    const rawScore =
      categoryScore +
      productAffinity +
      perfComponents.performance +
      perfComponents.popularity +
      commercialScore +
      stock +
      exploration -
      categoryCompatibility.penalty;

    const reasons = buildReasons({
      categoryScore,
      productAffinity,
      performance: perfComponents.performance,
      popularity: perfComponents.popularity,
      previouslyViewed,
      exploration,
    });

    candidates.push({
      ...product,
      previously_viewed: previouslyViewed,
      base_score: round(clamp(rawScore, 0, 100), 2),
      score: round(clamp(rawScore, 0, 100), 2),
      reasons,
      normalized_category: canonicalCategory,
      components: {
        category_affinity: round(categoryScore, 2),
        product_affinity: round(productAffinity, 2),
        performance: round(perfComponents.performance, 2),
        popularity: round(perfComponents.popularity, 2),
        commercial_quality: round(commercialScore, 2),
        stock: round(stock, 2),
        exploration: round(exploration, 2),
        category_mismatch_penalty: round(-categoryCompatibility.penalty, 2),
        diversity_adjustment: 0,
      },
      performance: {
        detail_visitors: toNumber(perf?.detail_visitors, 0),
        cart_visitors: toNumber(perf?.cart_visitors, 0),
        buy_now_visitors: toNumber(perf?.buy_now_visitors, 0),
        cart_rate_proxy: round(toNumber(perf?.cart_rate_proxy, 0), 4),
      },
    });
  }

  candidates.sort((a, b) => b.base_score - a.base_score || a.name.localeCompare(b.name, "pt-BR"));

  // Re-ranking com diversidade: evita preencher o topo inteiro com a mesma categoria,
  // sem destruir a personalização principal.
  const remaining = candidates.slice();
  const selected = [];
  const categoryCounts = new Map();

  while (remaining.length && selected.length < Math.max(1, Math.min(20, Number(limit) || 8))) {
    let bestIndex = 0;
    let bestAdjusted = -Infinity;

    for (let index = 0; index < remaining.length; index += 1) {
      const candidate = remaining[index];
      const categoryToken = normalizeInterestCategory(candidate.category) || "semcategoria";
      const count = categoryCounts.get(categoryToken) || 0;
      const preferredCategoryRatio = profileCategories.get(categoryToken) || 0;
      const isPreferredCategory = preferredCategoryRatio >= 0.55;
      const diversityPenalty = isPreferredCategory
        ? (count === 0 ? 0 : count === 1 ? 1.25 : 4.5 + (count - 2) * 2.5)
        : (count === 0 ? 0 : count === 1 ? 3 : 8 + (count - 2) * 3);
      const previousCategory = selected.length
        ? normalizeInterestCategory(selected[selected.length - 1].category)
        : "";
      const consecutivePenalty = previousCategory === categoryToken
        ? (isPreferredCategory ? 0.5 : 1.25)
        : 0;
      const adjusted = candidate.base_score - diversityPenalty - consecutivePenalty;

      if (adjusted > bestAdjusted) {
        bestAdjusted = adjusted;
        bestIndex = index;
      }
    }

    const [chosen] = remaining.splice(bestIndex, 1);
    const categoryToken = normalizeInterestCategory(chosen.category) || "semcategoria";
    const diversityAdjustment = round(bestAdjusted - chosen.base_score, 2);
    chosen.score = round(clamp(bestAdjusted, 0, 100), 2);
    chosen.components.diversity_adjustment = diversityAdjustment;
    chosen.rank = selected.length + 1;
    selected.push(chosen);
    categoryCounts.set(categoryToken, (categoryCounts.get(categoryToken) || 0) + 1);
  }

  return {
    version: "recommendation-v2.2-active",
    mode: "active",
    intent_version: String(profile?.version || "unknown"),
    intent_score: intentScore,
    intent_confidence: intentConfidence,
    stage: profile?.stage || null,
    price_affinity_used: false,
    category_normalization: "semantic-v1",
    exploration_mode: "confidence_adaptive",
    top_categories: Array.isArray(profile?.top_categories) ? profile.top_categories.slice(0, 5) : [],
    candidates_available: candidates.length,
    recommendations: selected.map(({ raw, available, ...product }) => product),
  };
}

export const RECOMMENDATION_PRODUCT_EVENT_TYPES = Object.freeze(Array.from(PRODUCT_EVENT_TYPES));
