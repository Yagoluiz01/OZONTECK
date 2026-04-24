const env = globalThis.env || {};

const SUPABASE_URL =
  env.supabaseUrl ||
  process.env.SUPABASE_URL ||
  process.env.NEXT_PUBLIC_SUPABASE_URL;

const SUPABASE_SERVICE_ROLE_KEY =
  env.supabaseServiceRoleKey ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY;

function ensureSupabaseConfig() {
  if (!SUPABASE_URL) {
    throw new Error("SUPABASE_URL não configurado.");
  }

  if (!SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY não configurado.");
  }
}

function getHeaders(extra = {}) {
  return {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    ...extra,
  };
}

function buildUrl(path) {
  return `${SUPABASE_URL}/rest/v1/${path}`;
}

function toNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function roundMoney(value) {
  return Number(toNumber(value, 0).toFixed(2));
}

async function supabaseFetch(path, options = {}) {
  ensureSupabaseConfig();

  const response = await fetch(buildUrl(path), {
    ...options,
    headers: getHeaders(options.headers || {}),
  });

  const text = await response.text();
  let json = null;

  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }

  if (!response.ok) {
    throw new Error(
      `Erro Supabase [${response.status}] ${
        typeof json === "string" ? json : JSON.stringify(json)
      }`
    );
  }

  return json;
}

function calculatePricing(input) {
  const costPrice = roundMoney(input.cost_price);
  const packagingCost = roundMoney(input.packaging_cost);
  const trafficCost = roundMoney(input.traffic_cost);
  const gatewayFeePercent = toNumber(input.gateway_fee_percent);
  const taxPercent = toNumber(input.tax_percent);
  const otherCosts = roundMoney(input.other_costs);
  const desiredMarginPercent = toNumber(input.desired_margin_percent);
  const averageShippingCost = roundMoney(input.average_shipping_cost);
  const shippingPolicy = input.shipping_policy || "customer_paid";

  const baseCost = costPrice + packagingCost + trafficCost + otherCosts;

  const variablePercent =
    gatewayFeePercent / 100 + taxPercent / 100;

  const minimumPrice =
    variablePercent >= 1 ? 0 : roundMoney(baseCost / (1 - variablePercent));

  const safeMarginPercent = Math.max(desiredMarginPercent, 15);

  const safePrice =
    variablePercent >= 1
      ? 0
      : roundMoney(baseCost / (1 - variablePercent - safeMarginPercent / 100));

  const suggestedPrice =
    variablePercent >= 1
      ? 0
      : roundMoney(
          baseCost / (1 - variablePercent - desiredMarginPercent / 100)
        );

  const gatewayValue = roundMoney(suggestedPrice * (gatewayFeePercent / 100));
  const taxValue = roundMoney(suggestedPrice * (taxPercent / 100));

  const unitProfit = roundMoney(
    suggestedPrice - baseCost - gatewayValue - taxValue
  );

  const realMarginPercent =
    suggestedPrice > 0
      ? roundMoney((unitProfit / suggestedPrice) * 100)
      : 0;

  return {
    cost_price: roundMoney(costPrice),
    packaging_cost: roundMoney(packagingCost),
    traffic_cost: roundMoney(trafficCost),
    gateway_fee_percent: roundMoney(gatewayFeePercent),
    tax_percent: roundMoney(taxPercent),
    other_costs: roundMoney(otherCosts),
    average_shipping_cost: roundMoney(averageShippingCost),
    shipping_policy: shippingPolicy,
    desired_margin_percent: roundMoney(desiredMarginPercent),
    cost_total: roundMoney(baseCost),
    minimum_price: roundMoney(minimumPrice),
    safe_price: roundMoney(safePrice),
    suggested_price: roundMoney(suggestedPrice),
    unit_profit: roundMoney(unitProfit),
    real_margin_percent: roundMoney(realMarginPercent),
  };
}

async function getProductById(productId) {
  const rows = await supabaseFetch(
    `products?select=id,name,sku,price&id=eq.${productId}&limit=1`,
    { method: "GET" }
  );

  return rows?.[0] || null;
}

async function createPricingHistory({
  productId,
  pricingId = null,
  pricingData,
  eventType,
  currentProductPrice = 0,
  notes = null,
}) {
  const body = {
    product_id: productId,
    pricing_id: pricingId,
    event_type: eventType,
    current_product_price: roundMoney(currentProductPrice),
    cost_price: roundMoney(pricingData.cost_price),
    packaging_cost: roundMoney(pricingData.packaging_cost),
    traffic_cost: roundMoney(pricingData.traffic_cost),
    gateway_fee_percent: roundMoney(pricingData.gateway_fee_percent),
    tax_percent: roundMoney(pricingData.tax_percent),
    other_costs: roundMoney(pricingData.other_costs),
    average_shipping_cost: roundMoney(pricingData.average_shipping_cost),
    shipping_policy: pricingData.shipping_policy || "customer_paid",
    desired_margin_percent: roundMoney(pricingData.desired_margin_percent),
    cost_total: roundMoney(pricingData.cost_total),
    minimum_price: roundMoney(pricingData.minimum_price),
    safe_price: roundMoney(pricingData.safe_price),
    suggested_price: roundMoney(pricingData.suggested_price),
    unit_profit: roundMoney(pricingData.unit_profit),
    real_margin_percent: roundMoney(pricingData.real_margin_percent),
    notes: notes || null,
  };

  const created = await supabaseFetch("product_pricing_history", {
    method: "POST",
    headers: {
      Prefer: "return=representation",
    },
    body: JSON.stringify(body),
  });

  return created?.[0] || null;
}

export async function listPricingRecords() {
  return await supabaseFetch(
    "product_pricing?select=*,products(id,name,sku,price)&order=updated_at.desc",
    { method: "GET" }
  );
}

export async function getPricingByProductId(productId) {
  const rows = await supabaseFetch(
    `product_pricing?select=*,products(id,name,sku,price)&product_id=eq.${productId}&limit=1`,
    { method: "GET" }
  );

  return rows?.[0] || null;
}

export async function getPricingHistoryByProductId(productId) {
  return await supabaseFetch(
    `product_pricing_history?select=*&product_id=eq.${productId}&order=created_at.desc`,
    { method: "GET" }
  );
}

export async function calculateProductPricing(payload) {
  const productId = payload.product_id || payload.productId;

  if (!productId) {
    throw new Error("product_id é obrigatório.");
  }

  const pricing = calculatePricing(payload);

  return {
    product_id: productId,
    ...pricing,
    notes: payload.notes || null,
  };
}

export async function saveProductPricing(payload) {
  const productId = payload.product_id || payload.productId;

  if (!productId) {
    throw new Error("product_id é obrigatório.");
  }

  const calculated = await calculateProductPricing(payload);
  const existing = await getPricingByProductId(productId);
  const product = await getProductById(productId);

  let saved = null;

  if (existing?.id) {
    const updated = await supabaseFetch(`product_pricing?id=eq.${existing.id}`, {
      method: "PATCH",
      headers: {
        Prefer: "return=representation",
      },
      body: JSON.stringify({
        ...calculated,
        notes: payload.notes || null,
      }),
    });

    saved = updated?.[0] || null;
  } else {
    const created = await supabaseFetch("product_pricing", {
      method: "POST",
      headers: {
        Prefer: "return=representation",
      },
      body: JSON.stringify({
        ...calculated,
        notes: payload.notes || null,
      }),
    });

    saved = created?.[0] || null;
  }

  if (saved) {
    await createPricingHistory({
      productId,
      pricingId: saved.id,
      pricingData: saved,
      eventType: "save_pricing",
      currentProductPrice: product?.price || 0,
      notes: payload.notes || null,
    });
  }

  return saved;
}

export async function applySuggestedPriceToProduct(productId) {
  if (!productId) {
    throw new Error("productId é obrigatório.");
  }

  const pricing = await getPricingByProductId(productId);

  if (!pricing) {
    throw new Error("Precificação não encontrada para este produto.");
  }

  const suggestedPrice = roundMoney(pricing.suggested_price);

  const updatedProduct = await supabaseFetch(`products?id=eq.${productId}`, {
    method: "PATCH",
    headers: {
      Prefer: "return=representation",
    },
    body: JSON.stringify({
      price: suggestedPrice,
    }),
  });

  const product = updatedProduct?.[0] || null;

  await createPricingHistory({
    productId,
    pricingId: pricing.id,
    pricingData: pricing,
    eventType: "apply_price",
    currentProductPrice: product?.price || suggestedPrice,
    notes: pricing.notes || null,
  });

  return {
    pricing,
    product,
  };
}

export async function listProductsForPricing(search = "") {
  const filters = ["select=id,name,sku,price"];

  if (search) {
    filters.push(`name=ilike.*${encodeURIComponent(search)}*`);
  }

  filters.push("order=created_at.desc");

  return await supabaseFetch(`products?${filters.join("&")}`, {
    method: "GET",
  });
}

export default {
  listPricingRecords,
  getPricingByProductId,
  getPricingHistoryByProductId,
  calculateProductPricing,
  saveProductPricing,
  applySuggestedPriceToProduct,
  listProductsForPricing,
};