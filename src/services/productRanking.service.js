const INACTIVE_STATUSES = new Set([
  "inactive",
  "inativo",
  "draft",
  "rascunho",
  "archived",
  "arquivado",
  "deleted",
  "excluido",
  "excluído",
  "false",
  "0",
]);

const PRODUCT_RANKING_WEIGHTS = Object.freeze({
  featured: 700,
  showOnHome: 450,
  manualHomeOrderBase: 1000,
  sales: 22,
  views: 0.75,
  marginPercent: 3,
  affiliateCommissionPercent: 2,
  hasVideo: 60,
  hasSecondImage: 30,
  kit: 40,
  newProduct30Days: 140,
  newProduct90Days: 60,
  stockHealthy: 80,
  stockAvailable: 50,
  stockUrgency: 35,
  discountPercent: 4,
  unavailablePenalty: 50000,
  inactivePenalty: 1000000,
});

function toNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function toBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "1") return true;
  if (value === 0 || value === "0") return false;

  const text = String(value ?? "").trim().toLowerCase();
  if (["true", "sim", "yes", "ativo", "active"].includes(text)) return true;
  if (["false", "nao", "não", "no", "inativo", "inactive"].includes(text)) return false;

  return fallback;
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function firstNumber(product = {}, fields = []) {
  for (const field of fields) {
    const value = product?.[field];
    if (value !== undefined && value !== null && value !== "") {
      return toNumber(value, 0);
    }
  }

  return 0;
}

function isInactiveProduct(product = {}) {
  const status = String(product?.status || product?.situacao || "").trim().toLowerCase();
  const activeFlag = product?.isActive ?? product?.is_active ?? product?.active;

  if (status && INACTIVE_STATUSES.has(status)) {
    return true;
  }

  if (activeFlag !== undefined && activeFlag !== null && activeFlag !== "") {
    return !toBoolean(activeFlag, true);
  }

  return false;
}

function getStockQuantity(product = {}) {
  return firstNumber(product, ["stockQuantity", "stock_quantity", "estoque", "stock"]);
}

function getProductAgeInDays(product = {}) {
  const dateValue =
    product?.createdAt ||
    product?.created_at ||
    product?.publishedAt ||
    product?.published_at ||
    product?.updatedAt ||
    product?.updated_at;

  if (!dateValue) return null;

  const timestamp = new Date(dateValue).getTime();
  if (!Number.isFinite(timestamp)) return null;

  const diff = Date.now() - timestamp;
  if (diff < 0) return 0;

  return diff / (1000 * 60 * 60 * 24);
}

function isKitProduct(product = {}) {
  const variantType = normalizeText(product?.variantType || product?.variant_type || "");
  if (variantType === "kit") return true;

  const text = normalizeText([
    product?.name,
    product?.nome,
    product?.slug,
    product?.sku,
    product?.variantLabel,
    product?.variant_label,
  ].filter(Boolean).join(" "));

  return /\b(kit|combo|conjunto|completo)\b/.test(text);
}

function getCompareAtPrice(product = {}) {
  const price = firstNumber(product, ["price", "preco", "sale_price", "salePrice"]);
  const compareAtPrice = firstNumber(product, [
    "compareAtPrice",
    "compare_at_price",
    "precoAntigo",
    "oldPrice",
    "old_price",
  ]);

  return compareAtPrice > price ? compareAtPrice : 0;
}

function hasValidMedia(product = {}, fields = []) {
  return fields.some((field) => {
    const value = String(product?.[field] || "").trim();
    return value && value !== "null" && value !== "undefined" && value !== "[object Object]";
  });
}

function calculateProductScore(product = {}, options = {}) {
  const weights = PRODUCT_RANKING_WEIGHTS;

  if (!product || typeof product !== "object") {
    return -weights.inactivePenalty;
  }

  let score = 0;

  if (isInactiveProduct(product)) {
    score -= weights.inactivePenalty;
  }

  const stock = getStockQuantity(product);
  if (stock <= 0) {
    score -= weights.unavailablePenalty;
  } else if (stock <= 5) {
    score += weights.stockUrgency;
  } else if (stock <= 15) {
    score += weights.stockAvailable;
  } else {
    score += weights.stockHealthy;
  }

  const featured = toBoolean(product?.featured ?? product?.is_featured, false);
  const showOnHome = toBoolean(
    product?.showOnHome ?? product?.show_on_home ?? product?.showHome ?? product?.show_home,
    false
  );

  if (featured) score += weights.featured;
  if (showOnHome) score += weights.showOnHome;

  const homeOrder = firstNumber(product, ["homeOrder", "home_order"]);
  if (homeOrder > 0) {
    score += Math.max(0, weights.manualHomeOrderBase - Math.min(homeOrder, weights.manualHomeOrderBase));
  }

  const salesCount = firstNumber(product, [
    "salesCount",
    "sales_count",
    "totalSales",
    "total_sales",
    "paidSales",
    "paid_sales",
    "soldQuantity",
    "sold_quantity",
  ]);
  const viewsCount = firstNumber(product, ["viewsCount", "views_count", "view_count", "total_views"]);
  const marginPercent = firstNumber(product, [
    "marginPercent",
    "margin_percent",
    "profitMargin",
    "profit_margin",
    "real_margin_percent",
  ]);
  const affiliateCommissionPercent = firstNumber(product, [
    "affiliateCommissionPercent",
    "affiliate_commission_percent",
    "commissionPercent",
    "commission_percent",
  ]);

  score += salesCount * weights.sales;
  score += viewsCount * weights.views;
  score += Math.max(0, marginPercent) * weights.marginPercent;
  score += Math.max(0, affiliateCommissionPercent) * weights.affiliateCommissionPercent;

  const price = firstNumber(product, ["price", "preco", "sale_price", "salePrice"]);
  const compareAtPrice = getCompareAtPrice(product);
  if (price > 0 && compareAtPrice > price) {
    const discountPercent = Math.min(((compareAtPrice - price) / compareAtPrice) * 100, 35);
    score += discountPercent * weights.discountPercent;
  }

  const ageInDays = getProductAgeInDays(product);
  if (ageInDays !== null) {
    if (ageInDays <= 30) score += weights.newProduct30Days;
    else if (ageInDays <= 90) score += weights.newProduct90Days;
  }

  if (hasValidMedia(product, ["videoUrl", "video_url", "productVideoUrl", "product_video_url", "video"])) {
    score += weights.hasVideo;
  }

  if (hasValidMedia(product, ["imageUrl2", "image_url_2", "imagem2", "image2"])) {
    score += weights.hasSecondImage;
  }

  if (isKitProduct(product)) {
    score += weights.kit;
  }

  if (options.context === "related") {
    score += getRelatedAffinityScore(product, options.currentProduct);
  }

  return Number(score.toFixed(4));
}

function addProductRankingScore(product = {}, options = {}) {
  const smartScore = calculateProductScore(product, options);

  return {
    ...product,
    smart_score: smartScore,
    smartScore,
  };
}

function compareByName(a = {}, b = {}) {
  return String(a.name || a.nome || "").localeCompare(String(b.name || b.nome || ""), "pt-BR");
}

function compareBySmartScore(a = {}, b = {}) {
  const scoreDiff = toNumber(b.smart_score ?? b.smartScore, 0) - toNumber(a.smart_score ?? a.smartScore, 0);
  if (scoreDiff !== 0) return scoreDiff;

  const stockDiff = getStockQuantity(b) - getStockQuantity(a);
  if (stockDiff !== 0) return stockDiff;

  return compareByName(a, b);
}

function rankStorefrontProducts(products = [], options = {}) {
  if (!Array.isArray(products)) return [];

  return products
    .map((product) => addProductRankingScore(product, options))
    .sort(compareBySmartScore);
}

function getHomeOrderValue(product = {}) {
  const value = firstNumber(product, ["homeOrder", "home_order"]);
  return value > 0 ? value : Number.MAX_SAFE_INTEGER;
}

function rankHomeProducts(products = [], options = {}) {
  if (!Array.isArray(products)) return [];

  return products
    .map((product) => addProductRankingScore(product, { ...options, context: "home" }))
    .sort((a, b) => {
      const orderA = getHomeOrderValue(a);
      const orderB = getHomeOrderValue(b);

      if (orderA !== orderB) return orderA - orderB;
      return compareBySmartScore(a, b);
    });
}

function getRelatedAffinityScore(product = {}, currentProduct = {}) {
  if (!currentProduct || typeof currentProduct !== "object") return 0;

  let score = 0;

  const currentCategory = normalizeText(currentProduct?.category || currentProduct?.categoria || "");
  const productCategory = normalizeText(product?.category || product?.categoria || "");
  if (currentCategory && productCategory && currentCategory === productCategory) {
    score += 500;
  }

  const currentGroup = normalizeText(currentProduct?.variantGroup || currentProduct?.variant_group || "");
  const productGroup = normalizeText(product?.variantGroup || product?.variant_group || "");
  if (currentGroup && productGroup && currentGroup === productGroup) {
    score += 350;
  }

  const currentPrice = firstNumber(currentProduct, ["price", "preco"]);
  const productPrice = firstNumber(product, ["price", "preco"]);
  if (currentPrice > 0 && productPrice > 0) {
    const distancePercent = Math.abs(productPrice - currentPrice) / currentPrice;
    score += Math.max(0, 120 - distancePercent * 120);
  }

  return score;
}

function rankRelatedProducts(currentProduct = {}, products = [], limit = 4) {
  if (!Array.isArray(products)) return [];

  const currentId = String(currentProduct?.id || "").trim();
  const ranked = rankStorefrontProducts(products, {
    context: "related",
    currentProduct,
  }).filter((product) => String(product?.id || "").trim() !== currentId);

  return ranked.slice(0, Math.max(1, Number(limit || 4)));
}

export {
  PRODUCT_RANKING_WEIGHTS,
  addProductRankingScore,
  calculateProductScore,
  rankHomeProducts,
  rankRelatedProducts,
  rankStorefrontProducts,
};
