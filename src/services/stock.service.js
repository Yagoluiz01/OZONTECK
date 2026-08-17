import { supabaseAdmin } from "../config/supabase.js";

const DEFAULTS = Object.freeze({
  analysisDays: 30,
  recentDays: 7,
  historyDays: 365,
  leadTimeDays: 7,
  safetyDays: 7,
  targetCoverageDays: 30,
  stagnantDays: 60,
  overstockDays: 90,
});

function clampInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round((toNumber(value) + Number.EPSILON) * factor) / factor;
}

function startOfWindow(days, now = new Date()) {
  return new Date(now.getTime() - days * 86400000);
}

function getObservedDays(productCreatedAt, requestedDays, now = new Date()) {
  const created = new Date(productCreatedAt || now);
  if (Number.isNaN(created.getTime())) return requestedDays;
  const ageDays = Math.max(1, Math.ceil((now.getTime() - created.getTime()) / 86400000));
  return Math.min(requestedDays, ageDays);
}

function getUnitCost(product = {}) {
  return Math.max(0, toNumber(product.cost_price));
}

function getUnitRetail(product = {}) {
  const salePrice = toNumber(product.sale_price);
  const price = toNumber(product.price);
  return Math.max(0, salePrice > 0 ? salePrice : price);
}

function createSalesBucket() {
  return {
    units7: 0,
    units30: 0,
    units60: 0,
    unitsHistory: 0,
    revenue30: 0,
    lastSaleAt: null,
  };
}

function normalizeSaleDate(item = {}) {
  const order = Array.isArray(item.orders) ? item.orders[0] : item.orders;
  return order?.paid_at || order?.created_at || item.created_at || null;
}

function aggregateSales(items = [], now = new Date(), settings = DEFAULTS) {
  const map = new Map();
  const recentStart = startOfWindow(settings.recentDays, now);
  const analysisStart = startOfWindow(settings.analysisDays, now);
  const stagnantStart = startOfWindow(settings.stagnantDays, now);

  for (const item of items) {
    const productId = String(item?.product_id || "").trim();
    if (!productId) continue;

    const soldAtRaw = normalizeSaleDate(item);
    const soldAt = soldAtRaw ? new Date(soldAtRaw) : null;
    if (!soldAt || Number.isNaN(soldAt.getTime())) continue;

    const quantity = Math.max(0, Math.trunc(toNumber(item.quantity)));
    if (quantity <= 0) continue;

    const bucket = map.get(productId) || createSalesBucket();
    bucket.unitsHistory += quantity;

    if (!bucket.lastSaleAt || soldAt > new Date(bucket.lastSaleAt)) {
      bucket.lastSaleAt = soldAt.toISOString();
    }

    if (soldAt >= stagnantStart) bucket.units60 += quantity;
    if (soldAt >= analysisStart) {
      bucket.units30 += quantity;
      bucket.revenue30 += quantity * Math.max(0, toNumber(item.unit_price));
    }
    if (soldAt >= recentStart) bucket.units7 += quantity;

    map.set(productId, bucket);
  }

  return map;
}

export function buildStockIntelligenceProduct(product = {}, sales = {}, inputSettings = {}, nowInput = new Date()) {
  const now = nowInput instanceof Date ? nowInput : new Date(nowInput);
  const settings = { ...DEFAULTS, ...inputSettings };
  const stock = Math.max(0, Math.trunc(toNumber(product.stock_quantity)));
  const observed30 = getObservedDays(product.created_at, settings.analysisDays, now);
  const observed7 = getObservedDays(product.created_at, settings.recentDays, now);
  const units30 = Math.max(0, Math.trunc(toNumber(sales.units30)));
  const units7 = Math.max(0, Math.trunc(toNumber(sales.units7)));
  const units60 = Math.max(0, Math.trunc(toNumber(sales.units60)));

  const avg30 = units30 / Math.max(1, observed30);
  const avg7 = units7 / Math.max(1, observed7);

  // Demanda prevista dá mais peso ao histórico de 30 dias, mas reage ao ritmo recente.
  const forecastDaily = avg30 > 0
    ? (avg30 * 0.7) + (avg7 * 0.3)
    : avg7;

  const coverageDays = forecastDaily > 0 ? stock / forecastDaily : null;
  const reorderPoint = Math.ceil(forecastDaily * (settings.leadTimeDays + settings.safetyDays));
  const targetStock = Math.ceil(forecastDaily * settings.targetCoverageDays);
  const suggestedPurchaseQty = forecastDaily > 0 && stock <= reorderPoint
    ? Math.max(0, targetStock - stock)
    : 0;

  const unitCost = getUnitCost(product);
  const unitRetail = getUnitRetail(product);
  const inventoryCostValue = stock * unitCost;
  const inventoryRetailValue = stock * unitRetail;
  const suggestedPurchaseCost = suggestedPurchaseQty * unitCost;

  const createdAt = product.created_at ? new Date(product.created_at) : null;
  const ageDays = createdAt && !Number.isNaN(createdAt.getTime())
    ? Math.max(0, Math.floor((now.getTime() - createdAt.getTime()) / 86400000))
    : null;

  const lastSaleAt = sales.lastSaleAt || null;
  const lastSaleDate = lastSaleAt ? new Date(lastSaleAt) : null;
  const daysSinceLastSale = lastSaleDate && !Number.isNaN(lastSaleDate.getTime())
    ? Math.max(0, Math.floor((now.getTime() - lastSaleDate.getTime()) / 86400000))
    : null;

  const isMatureEnoughForStagnant = ageDays === null || ageDays >= settings.stagnantDays;
  const isStagnant = settings.hasGlobalSalesHistory !== false && stock > 0 && units60 === 0 && isMatureEnoughForStagnant;
  const isOverstock = forecastDaily > 0 && coverageDays !== null && coverageDays > settings.overstockDays;

  let risk = "healthy";
  if (stock === 0) risk = "out_of_stock";
  else if (isStagnant) risk = "stagnant";
  else if (forecastDaily > 0 && coverageDays <= settings.leadTimeDays + settings.safetyDays) risk = "critical";
  else if (forecastDaily > 0 && coverageDays <= settings.targetCoverageDays) risk = "attention";
  else if (isOverstock) risk = "overstock";
  else if (forecastDaily <= 0) risk = "no_history";

  const ruptureDate = forecastDaily > 0 && stock > 0
    ? new Date(now.getTime() + coverageDays * 86400000).toISOString()
    : stock === 0 ? now.toISOString() : null;

  const trendPercent = avg30 > 0 ? ((avg7 - avg30) / avg30) * 100 : null;

  return {
    id: product.id,
    name: product.name || "Produto",
    sku: product.sku || null,
    category: product.category || null,
    status: product.status || null,
    imageUrl: product.image_thumb_url || product.image_card_url || product.image_url || null,
    stock,
    unitCost: round(unitCost),
    unitRetail: round(unitRetail),
    inventoryCostValue: round(inventoryCostValue),
    inventoryRetailValue: round(inventoryRetailValue),
    sales: {
      units7,
      units30,
      units60,
      revenue30: round(sales.revenue30),
      averageDaily30: round(avg30, 3),
      averageDaily7: round(avg7, 3),
      forecastDaily: round(forecastDaily, 3),
      trendPercent: trendPercent === null ? null : round(trendPercent, 1),
      lastSaleAt,
      daysSinceLastSale,
    },
    coverageDays: coverageDays === null ? null : round(coverageDays, 1),
    ruptureDate,
    reorderPoint,
    targetStock,
    suggestedPurchaseQty,
    suggestedPurchaseCost: round(suggestedPurchaseCost),
    capitalTied: isStagnant || isOverstock ? round(inventoryCostValue) : 0,
    risk,
  };
}

function riskWeight(risk) {
  return {
    out_of_stock: 0,
    critical: 1,
    attention: 2,
    stagnant: 3,
    overstock: 4,
    no_history: 5,
    healthy: 6,
  }[risk] ?? 9;
}

function summarize(products = []) {
  const summary = {
    totalProducts: products.length,
    inventoryUnits: 0,
    inventoryCostValue: 0,
    inventoryRetailValue: 0,
    outOfStockCount: 0,
    criticalCount: 0,
    attentionCount: 0,
    stagnantCount: 0,
    overstockCount: 0,
    noHistoryCount: 0,
    suggestedPurchaseUnits: 0,
    suggestedPurchaseCost: 0,
    capitalTied: 0,
  };

  for (const product of products) {
    summary.inventoryUnits += product.stock;
    summary.inventoryCostValue += product.inventoryCostValue;
    summary.inventoryRetailValue += product.inventoryRetailValue;
    summary.suggestedPurchaseUnits += product.suggestedPurchaseQty;
    summary.suggestedPurchaseCost += product.suggestedPurchaseCost;
    summary.capitalTied += product.capitalTied;
    if (product.risk === "out_of_stock") summary.outOfStockCount += 1;
    if (product.risk === "critical") summary.criticalCount += 1;
    if (product.risk === "attention") summary.attentionCount += 1;
    if (product.risk === "stagnant") summary.stagnantCount += 1;
    if (product.risk === "overstock") summary.overstockCount += 1;
    if (product.risk === "no_history") summary.noHistoryCount += 1;
  }

  for (const key of ["inventoryCostValue", "inventoryRetailValue", "suggestedPurchaseCost", "capitalTied"]) {
    summary[key] = round(summary[key]);
  }

  return summary;
}

async function fetchProducts() {
  const { data, error } = await supabaseAdmin
    .from("products")
    .select("id,name,sku,category,status,stock_quantity,cost_price,sale_price,price,created_at,image_url,image_thumb_url,image_card_url")
    .order("name", { ascending: true });

  if (error) throw new Error(error.message || "Erro ao carregar produtos para estoque.");
  return data || [];
}

async function fetchPaidSales(historyDays) {
  const historyStart = startOfWindow(historyDays).toISOString();
  const pageSize = 1000;
  let from = 0;
  const rows = [];

  while (true) {
    const { data, error } = await supabaseAdmin
      .rpc("get_admin_stock_sales_history", {
        p_history_start: historyStart,
      })
      .range(from, from + pageSize - 1);

    if (error) {
      throw new Error(error.message || "Erro ao carregar histórico de vendas para estoque.");
    }

    const page = Array.isArray(data) ? data : [];
    rows.push(...page.map((item) => ({
      ...item,
      created_at: item.sold_at,
      orders: {
        paid_at: item.sold_at,
        created_at: item.sold_at,
      },
    })));

    if (page.length < pageSize) break;
    from += pageSize;
    if (from >= 100000) break;
  }

  return rows;
}

export function normalizeStockIntelligenceSettings(query = {}) {
  return {
    analysisDays: clampInteger(query.analysisDays, DEFAULTS.analysisDays, 7, 90),
    recentDays: DEFAULTS.recentDays,
    historyDays: clampInteger(query.historyDays, DEFAULTS.historyDays, 90, 730),
    leadTimeDays: clampInteger(query.leadTimeDays, DEFAULTS.leadTimeDays, 1, 90),
    safetyDays: clampInteger(query.safetyDays, DEFAULTS.safetyDays, 0, 60),
    targetCoverageDays: clampInteger(query.targetCoverageDays, DEFAULTS.targetCoverageDays, 7, 180),
    stagnantDays: clampInteger(query.stagnantDays, DEFAULTS.stagnantDays, 30, 365),
    overstockDays: clampInteger(query.overstockDays, DEFAULTS.overstockDays, 45, 365),
  };
}

export async function getStockIntelligence(inputSettings = {}) {
  const settings = normalizeStockIntelligenceSettings(inputSettings);
  const now = new Date();
  const [products, paidItems] = await Promise.all([
    fetchProducts(),
    fetchPaidSales(settings.historyDays),
  ]);

  const salesByProduct = aggregateSales(paidItems, now, settings);
  const intelligence = products.map((product) =>
    buildStockIntelligenceProduct(
      product,
      salesByProduct.get(String(product.id)) || {},
      { ...settings, hasGlobalSalesHistory: paidItems.length > 0 },
      now
    )
  );

  intelligence.sort((a, b) => {
    const riskDifference = riskWeight(a.risk) - riskWeight(b.risk);
    if (riskDifference !== 0) return riskDifference;
    if (a.coverageDays === null && b.coverageDays !== null) return 1;
    if (a.coverageDays !== null && b.coverageDays === null) return -1;
    if (a.coverageDays !== null && b.coverageDays !== null && a.coverageDays !== b.coverageDays) {
      return a.coverageDays - b.coverageDays;
    }
    return String(a.name).localeCompare(String(b.name), "pt-BR");
  });

  const actionable = intelligence.filter((product) =>
    ["out_of_stock", "critical", "attention", "stagnant", "overstock"].includes(product.risk)
  );

  return {
    generatedAt: now.toISOString(),
    settings,
    summary: summarize(intelligence),
    products: intelligence,
    actions: actionable.slice(0, 12),
    dataQuality: {
      paidOrderItemsAnalyzed: paidItems.length,
      hasPaidSalesHistory: paidItems.length > 0,
      message: paidItems.length > 0
        ? null
        : "Ainda não há vendas pagas no período analisado. Métricas de giro e previsão serão preenchidas conforme o histórico de vendas crescer.",
    },
  };
}
