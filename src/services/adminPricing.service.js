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

function normalizePercent(value) {
  const percent = toNumber(value, 0);

  if (percent < 0) return 0;
  if (percent > 100) return 100;

  return percent;
}

function getAutoPercent(value, fallback) {
  const number = Number(value);

  if (!Number.isFinite(number) || number <= 0) {
    return fallback;
  }

  return number;
}

function normalizePaymentMethod(value) {
  const method = String(value || "pix").trim();

  const allowed = ["pix", "boleto", "credit_card", "debit_card", "wallet"];

  if (!allowed.includes(method)) {
    throw new Error(
      "payment_method inválido. Use: pix, boleto, credit_card, debit_card ou wallet."
    );
  }

  return method;
}

function normalizeReceiptTerm(value) {
  const term = String(value || "instant").trim();

  const allowed = ["instant", "14_days", "30_days"];

  if (!allowed.includes(term)) {
    throw new Error("receipt_term inválido. Use: instant, 14_days ou 30_days.");
  }

  return term;
}

function normalizeInstallments(value) {
  const installments = Math.trunc(toNumber(value, 1));

  if (installments < 1 || installments > 12) {
    throw new Error("installments inválido. Use um número entre 1 e 12.");
  }

  return installments;
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

function calculatePriceForCommission({
  baseCost,
  gatewayFeePercent,
  taxPercent,
  commissionPercent,
  marginPercent,
}) {
  const variablePercent =
    normalizePercent(gatewayFeePercent) / 100 +
    normalizePercent(taxPercent) / 100 +
    normalizePercent(commissionPercent) / 100 +
    normalizePercent(marginPercent) / 100;

  if (variablePercent >= 1) {
    return 0;
  }

  return roundMoney(baseCost / (1 - variablePercent));
}

function calculateProfitForPrice({
  price,
  baseCost,
  gatewayFeePercent,
  taxPercent,
  commissionPercent,
}) {
  const gatewayValue = roundMoney(
    price * (normalizePercent(gatewayFeePercent) / 100)
  );

  const taxValue = roundMoney(price * (normalizePercent(taxPercent) / 100));

  const commissionValue = roundMoney(
    price * (normalizePercent(commissionPercent) / 100)
  );

  const profit = roundMoney(
    price - baseCost - gatewayValue - taxValue - commissionValue
  );

  const marginPercent = price > 0 ? roundMoney((profit / price) * 100) : 0;

  return {
    gateway_value: gatewayValue,
    tax_value: taxValue,
    commission_value: commissionValue,
    profit,
    margin_percent: marginPercent,
  };
}

function buildRiskStatus({
  suggestedPrice,
  priceWithMaxCommission,
  profitWithMaxCommission,
  marginWithMaxCommissionPercent,
  minimumCompanyMarginPercent,
  maxAffiliateCommissionPercent,
  specialAffiliateCommissionPercent,
}) {
  if (!suggestedPrice || suggestedPrice <= 0) {
    return {
      status: "invalid",
      risk_message:
        "Precificação inválida. Verifique se a soma de taxas, comissão e margem não passou de 100%.",
    };
  }

  if (maxAffiliateCommissionPercent >= 50 && priceWithMaxCommission <= 0) {
    return {
      status: "danger",
      risk_message:
        "A comissão máxima informada é muito alta para a margem atual. Aumente o preço, reduza custos ou reduza comissão.",
    };
  }

  if (profitWithMaxCommission <= 0) {
    return {
      status: "loss",
      risk_message:
        "Com a comissão máxima, este produto pode dar prejuízo. Não aplique comissão especial sem revisar o preço.",
    };
  }

  if (marginWithMaxCommissionPercent < minimumCompanyMarginPercent) {
    return {
      status: "attention",
      risk_message:
        "Com a comissão máxima, a margem da empresa fica abaixo do mínimo definido.",
    };
  }

  if (specialAffiliateCommissionPercent > maxAffiliateCommissionPercent) {
    return {
      status: "attention",
      risk_message:
        "A comissão especial está maior que a comissão máxima segura definida para este produto.",
    };
  }

  return {
    status: "healthy",
    risk_message:
      "Precificação saudável. O produto suporta os custos e a comissão configurada.",
  };
}

function calculatePricing(input) {
  const costPrice = roundMoney(input.cost_price);
  const packagingCost = roundMoney(input.packaging_cost);
  const trafficCost = roundMoney(input.traffic_cost);
  const gatewayFeePercent = normalizePercent(input.gateway_fee_percent);
  const taxPercent = normalizePercent(input.tax_percent);
  const otherCosts = roundMoney(input.other_costs);
  const desiredMarginPercent = normalizePercent(input.desired_margin_percent);
  const averageShippingCost = roundMoney(input.average_shipping_cost);
  const shippingPolicy = input.shipping_policy || "customer_paid";

  const affiliateCommissionPercent = normalizePercent(
    getAutoPercent(input.affiliate_commission_percent, 10)
  );

  const maxAffiliateCommissionPercent = normalizePercent(
    getAutoPercent(input.max_affiliate_commission_percent, 50)
  );

  const specialAffiliateCommissionPercent = normalizePercent(
    getAutoPercent(input.special_affiliate_commission_percent, 50)
  );

  const minimumCompanyMarginPercent = normalizePercent(
    getAutoPercent(input.minimum_company_margin_percent, 15)
  );

  const commissionScenarioPercent = normalizePercent(
    getAutoPercent(input.commission_scenario_percent, 50)
  );

  const baseCost = roundMoney(
    costPrice + packagingCost + trafficCost + otherCosts
  );

  const basicVariablePercent = gatewayFeePercent / 100 + taxPercent / 100;

  const minimumPrice =
    basicVariablePercent >= 1
      ? 0
      : roundMoney(baseCost / (1 - basicVariablePercent));

  const safeMarginPercent = Math.max(
    desiredMarginPercent,
    minimumCompanyMarginPercent,
    15
  );

  const safePrice = calculatePriceForCommission({
    baseCost,
    gatewayFeePercent,
    taxPercent,
    commissionPercent: affiliateCommissionPercent,
    marginPercent: safeMarginPercent,
  });

  const calculatedSuggestedPrice = calculatePriceForCommission({
    baseCost,
    gatewayFeePercent,
    taxPercent,
    commissionPercent: affiliateCommissionPercent,
    marginPercent: desiredMarginPercent,
  });

  const priceWithDefaultCommission = calculatedSuggestedPrice;

  const manualSuggestedPrice = roundMoney(
    input.suggested_price_override ||
      input.manual_suggested_price ||
      input.target_suggested_price ||
      0
  );

  const suggestedPrice =
    manualSuggestedPrice > calculatedSuggestedPrice
      ? manualSuggestedPrice
      : calculatedSuggestedPrice;

  const priceWithMaxCommission = calculatePriceForCommission({
    baseCost,
    gatewayFeePercent,
    taxPercent,
    commissionPercent: maxAffiliateCommissionPercent,
    marginPercent: minimumCompanyMarginPercent,
  });

  const priceWithSpecialCommission = calculatePriceForCommission({
    baseCost,
    gatewayFeePercent,
    taxPercent,
    commissionPercent: specialAffiliateCommissionPercent,
    marginPercent: minimumCompanyMarginPercent,
  });

  const defaultProfitData = calculateProfitForPrice({
    price: priceWithDefaultCommission,
    baseCost,
    gatewayFeePercent,
    taxPercent,
    commissionPercent: affiliateCommissionPercent,
  });

  const maxProfitData = calculateProfitForPrice({
    price: priceWithMaxCommission,
    baseCost,
    gatewayFeePercent,
    taxPercent,
    commissionPercent: maxAffiliateCommissionPercent,
  });

  const specialProfitData = calculateProfitForPrice({
    price: priceWithSpecialCommission,
    baseCost,
    gatewayFeePercent,
    taxPercent,
    commissionPercent: specialAffiliateCommissionPercent,
  });

  const suggestedProfitData = calculateProfitForPrice({
    price: suggestedPrice,
    baseCost,
    gatewayFeePercent,
    taxPercent,
    commissionPercent: affiliateCommissionPercent,
  });

  const risk = buildRiskStatus({
    suggestedPrice,
    priceWithMaxCommission,
    profitWithMaxCommission: maxProfitData.profit,
    marginWithMaxCommissionPercent: maxProfitData.margin_percent,
    minimumCompanyMarginPercent,
    maxAffiliateCommissionPercent,
    specialAffiliateCommissionPercent,
  });

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

    affiliate_commission_percent: roundMoney(affiliateCommissionPercent),
    max_affiliate_commission_percent: roundMoney(maxAffiliateCommissionPercent),
    special_affiliate_commission_percent: roundMoney(
      specialAffiliateCommissionPercent
    ),
    minimum_company_margin_percent: roundMoney(minimumCompanyMarginPercent),
    commission_scenario_percent: roundMoney(commissionScenarioPercent),

    cost_total: roundMoney(baseCost),
    minimum_price: roundMoney(minimumPrice),
    safe_price: roundMoney(safePrice),
    suggested_price: roundMoney(suggestedPrice),
    unit_profit: roundMoney(suggestedProfitData.profit),
    real_margin_percent: roundMoney(suggestedProfitData.margin_percent),

    price_with_default_commission: roundMoney(priceWithDefaultCommission),
    price_with_max_commission: roundMoney(priceWithMaxCommission),
    price_with_special_commission: roundMoney(priceWithSpecialCommission),

    profit_with_default_commission: roundMoney(defaultProfitData.profit),
    profit_with_max_commission: roundMoney(maxProfitData.profit),
    profit_with_special_commission: roundMoney(specialProfitData.profit),

    margin_with_default_commission_percent: roundMoney(
      defaultProfitData.margin_percent
    ),
    margin_with_max_commission_percent: roundMoney(maxProfitData.margin_percent),
    margin_with_special_commission_percent: roundMoney(
      specialProfitData.margin_percent
    ),

    status: risk.status,
    risk_message: risk.risk_message,
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

    affiliate_commission_percent: roundMoney(
      pricingData.affiliate_commission_percent
    ),
    max_affiliate_commission_percent: roundMoney(
      pricingData.max_affiliate_commission_percent
    ),
    special_affiliate_commission_percent: roundMoney(
      pricingData.special_affiliate_commission_percent
    ),
    minimum_company_margin_percent: roundMoney(
      pricingData.minimum_company_margin_percent
    ),
    commission_scenario_percent: roundMoney(
      pricingData.commission_scenario_percent
    ),

    cost_total: roundMoney(pricingData.cost_total),
    minimum_price: roundMoney(pricingData.minimum_price),
    safe_price: roundMoney(pricingData.safe_price),
    suggested_price: roundMoney(pricingData.suggested_price),
    unit_profit: roundMoney(pricingData.unit_profit),
    real_margin_percent: roundMoney(pricingData.real_margin_percent),

    price_with_default_commission: roundMoney(
      pricingData.price_with_default_commission
    ),
    price_with_max_commission: roundMoney(pricingData.price_with_max_commission),
    price_with_special_commission: roundMoney(
      pricingData.price_with_special_commission
    ),

    profit_with_default_commission: roundMoney(
      pricingData.profit_with_default_commission
    ),
    profit_with_max_commission: roundMoney(
      pricingData.profit_with_max_commission
    ),
    profit_with_special_commission: roundMoney(
      pricingData.profit_with_special_commission
    ),

    margin_with_default_commission_percent: roundMoney(
      pricingData.margin_with_default_commission_percent
    ),
    margin_with_max_commission_percent: roundMoney(
      pricingData.margin_with_max_commission_percent
    ),
    margin_with_special_commission_percent: roundMoney(
      pricingData.margin_with_special_commission_percent
    ),

    status: pricingData.status || "pending",
    risk_message: pricingData.risk_message || null,
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

export async function listPaymentFeeRules() {
  return await supabaseFetch(
    "payment_fee_rules?select=*&provider=eq.mercado_pago&is_active=eq.true&order=payment_method.asc,receipt_term.asc,installments.asc",
    { method: "GET" }
  );
}

export async function simulatePaymentFee(payload = {}) {
  const amount = roundMoney(payload.amount || payload.gross_amount);

  if (!amount || amount <= 0) {
    throw new Error("amount é obrigatório e precisa ser maior que zero.");
  }

  const paymentMethod = normalizePaymentMethod(
    payload.payment_method || payload.paymentMethod
  );

  const receiptTerm = normalizeReceiptTerm(
    payload.receipt_term || payload.receiptTerm
  );

  const installments = normalizeInstallments(payload.installments || 1);

  let rows = await supabaseFetch(
    `payment_fee_rules?select=*&provider=eq.mercado_pago&payment_method=eq.${encodeURIComponent(
      paymentMethod
    )}&receipt_term=eq.${encodeURIComponent(
      receiptTerm
    )}&installments=eq.${installments}&is_active=eq.true&limit=1`,
    { method: "GET" }
  );

  let rule = rows?.[0] || null;

  if (!rule && paymentMethod !== "credit_card") {
    rows = await supabaseFetch(
      `payment_fee_rules?select=*&provider=eq.mercado_pago&payment_method=eq.${encodeURIComponent(
        paymentMethod
      )}&installments=eq.1&is_active=eq.true&limit=1`,
      { method: "GET" }
    );

    rule = rows?.[0] || null;
  }

  if (!rule && paymentMethod === "credit_card" && installments > 1) {
    rows = await supabaseFetch(
      `payment_fee_rules?select=*&provider=eq.mercado_pago&payment_method=eq.credit_card&receipt_term=eq.instant&installments=eq.${installments}&is_active=eq.true&limit=1`,
      { method: "GET" }
    );

    rule = rows?.[0] || null;
  }

  if (!rule) {
    throw new Error(
      "Nenhuma taxa ativa encontrada para esta forma de pagamento."
    );
  }

  const percentFee = normalizePercent(rule.percent_fee);
  const fixedFee = roundMoney(rule.fixed_fee);
  const feeAmount = roundMoney(amount * (percentFee / 100) + fixedFee);
  const netAmount = roundMoney(amount - feeAmount);
  const effectivePercent = amount > 0 ? roundMoney((feeAmount / amount) * 100) : 0;

  return {
    provider: rule.provider,
    rule_id: rule.id,

    payment_method: rule.payment_method,
    receipt_term: rule.receipt_term,
    installments: rule.installments,

    gross_amount: amount,
    percent_fee: roundMoney(percentFee),
    fixed_fee: fixedFee,
    fee_amount: feeAmount,
    net_amount: netAmount,
    effective_percent: effectivePercent,

    notes: rule.notes || null,
  };
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

export async function applySuggestedPriceToProduct(productId, payload = {}) {
  if (!productId) {
    throw new Error("productId é obrigatório.");
  }

  const existingPricing = await getPricingByProductId(productId);

  if (!existingPricing && !Object.keys(payload || {}).length) {
    throw new Error("Precificação não encontrada para este produto.");
  }

  let pricing = existingPricing;

  const requestedSuggestedPrice = roundMoney(
    payload.suggested_price_override ||
      payload.manual_suggested_price ||
      payload.target_suggested_price ||
      0
  );

  if (requestedSuggestedPrice > 0) {
    pricing = await saveProductPricing({
      ...(payload || {}),
      product_id: productId,
      suggested_price_override: requestedSuggestedPrice,
    });
  }

  if (!pricing) {
    throw new Error("Precificação não encontrada para este produto.");
  }

  const suggestedPrice = roundMoney(
    requestedSuggestedPrice > 0
      ? Math.max(requestedSuggestedPrice, pricing.suggested_price || 0)
      : pricing.suggested_price
  );

  if (!suggestedPrice || suggestedPrice <= 0) {
    throw new Error(
      "Preço sugerido inválido. Calcule e salve a precificação antes de aplicar."
    );
  }

  if (
    pricing.status === "loss" ||
    pricing.status === "danger" ||
    pricing.status === "invalid"
  ) {
    throw new Error(
      pricing.risk_message ||
        "Este produto está com risco financeiro. Ajuste a precificação antes de aplicar."
    );
  }

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
    pricingData: {
      ...pricing,
      suggested_price: suggestedPrice,
    },
    eventType: "apply_price",
    currentProductPrice: product?.price || suggestedPrice,
    notes: pricing.notes || null,
  });

  return {
    pricing: {
      ...pricing,
      suggested_price: suggestedPrice,
    },
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
  listPaymentFeeRules,
  simulatePaymentFee,
  listPricingRecords,
  getPricingByProductId,
  getPricingHistoryByProductId,
  calculateProductPricing,
  saveProductPricing,
  applySuggestedPriceToProduct,
  listProductsForPricing,
};