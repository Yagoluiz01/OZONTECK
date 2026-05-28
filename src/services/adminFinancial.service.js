import { getFiscalSettings } from "./adminFiscal.service.js";

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

function toNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function roundMoney(value) {
  return Number(toNumber(value, 0).toFixed(2));
}

function buildUrl(path) {
  return `${SUPABASE_URL}/rest/v1/${path}`;
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

async function optionalSupabaseFetch(path, options = {}, fallback = []) {
  try {
    return await supabaseFetch(path, options);
  } catch (error) {
    console.warn(
      "FINANCEIRO OPTIONAL FETCH:",
      error?.message || "Não foi possível buscar dados opcionais."
    );
    return fallback;
  }
}

function getPeriodRange(period) {
  const now = new Date();
  const start = new Date(now);
  const end = new Date(now);

  if (period === "today") {
    start.setHours(0, 0, 0, 0);
    end.setHours(23, 59, 59, 999);
  } else if (period === "7d") {
    start.setDate(start.getDate() - 6);
    start.setHours(0, 0, 0, 0);
    end.setHours(23, 59, 59, 999);
  } else if (period === "30d") {
    start.setDate(start.getDate() - 29);
    start.setHours(0, 0, 0, 0);
    end.setHours(23, 59, 59, 999);
  } else if (period === "month") {
    start.setDate(1);
    start.setHours(0, 0, 0, 0);
    end.setHours(23, 59, 59, 999);
  } else {
    start.setDate(start.getDate() - 29);
    start.setHours(0, 0, 0, 0);
    end.setHours(23, 59, 59, 999);
  }

  return {
    startIso: start.toISOString(),
    endIso: end.toISOString(),
  };
}


function getComparableDate(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

function isDateInsideRange(value, startIso, endIso) {
  const date = getComparableDate(value);

  if (!date) return false;

  const start = new Date(startIso);
  const end = new Date(endIso);

  return date >= start && date <= end;
}

function normalizeStatusValue(value = "") {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, "_");
}

const PAID_STATUS_VALUES = new Set([
  "paid",
  "approved",
  "completed",
  "complete",
  "pago",
  "aprovado",
  "concluido",
]);

const CANCELED_STATUS_VALUES = new Set([
  "cancelled",
  "canceled",
  "cancelado",
  "rejected",
  "rejeitado",
  "refunded",
  "estornado",
  "charged_back",
  "chargeback",
  "failed",
  "falhou",
  "expired",
  "expirado",
]);

function getOrderStatusValues(order = {}) {
  return [
    order.financial_status,
    order.payment_status,
    order.payment_raw_status,
    order.status,
    order.order_status,
  ]
    .map(normalizeStatusValue)
    .filter(Boolean);
}

function isOrderCanceled(order = {}) {
  return getOrderStatusValues(order).some((status) => CANCELED_STATUS_VALUES.has(status));
}

function isOrderPaid(order = {}) {
  if (isOrderCanceled(order)) return false;

  const statusValues = getOrderStatusValues(order);
  const explicitPaid = statusValues.some((status) => PAID_STATUS_VALUES.has(status));

  if (explicitPaid) return true;

  return Boolean(order.paid_at || order.payment_approved_at || order.approved_at);
}

function getFinancialStatus(order = {}) {
  if (isOrderCanceled(order)) return "canceled";
  if (isOrderPaid(order)) return "paid";
  return "pending";
}

function isRevenueOrder(order = {}) {
  return getFinancialStatus(order) === "paid";
}

function getOrderFinancialDate(order = {}) {
  return (
    order.paid_at ||
    order.payment_approved_at ||
    order.approved_at ||
    order.created_at ||
    null
  );
}

function getOrderAmount(order = {}) {
  return roundMoney(
    toNumber(order.gross_amount) ||
      toNumber(order.total_amount) ||
      toNumber(order.total) ||
      toNumber(order.amount) ||
      toNumber(order.total_price) ||
      toNumber(order.payment_amount) ||
      0
  );
}

function getShippingChargedAmount(order = {}) {
  return roundMoney(
    toNumber(order.shipping_amount) ||
      toNumber(order.freight_amount) ||
      toNumber(order.shipping_price) ||
      toNumber(order.delivery_fee) ||
      0
  );
}

function getShippingRealCost(order = {}) {
  return roundMoney(
    toNumber(order.shipping_cost) ||
      toNumber(order.shipping_label_cost) ||
      toNumber(order.shipping_quote_price) ||
      toNumber(order.label_cost) ||
      0
  );
}

function getGatewayFee(order = {}) {
  return roundMoney(
    toNumber(order.gateway_fee) ||
      toNumber(order.payment_gateway_fee) ||
      toNumber(order.mercado_pago_fee) ||
      toNumber(order.transaction_fee) ||
      0
  );
}

function getProductCost(order = {}) {
  return roundMoney(
    toNumber(order.product_cost) ||
      toNumber(order.products_cost) ||
      toNumber(order.cost_total) ||
      toNumber(order.items_cost) ||
      0
  );
}

function getAdCost(order = {}) {
  return roundMoney(
    toNumber(order.ad_cost) ||
      toNumber(order.traffic_cost) ||
      toNumber(order.marketing_cost) ||
      0
  );
}

function getOtherCosts(order = {}) {
  return roundMoney(
    toNumber(order.other_costs) ||
      toNumber(order.extra_costs) ||
      toNumber(order.operational_costs) ||
      0
  );
}

function getRefundAmount(order = {}) {
  return roundMoney(
    toNumber(order.refunds_amount) ||
      toNumber(order.refund_amount) ||
      toNumber(order.refunded_amount) ||
      0
  );
}

function getShippingRepasseStatus(shippingAmount, shippingCost) {
  if (shippingCost > shippingAmount) return "repor";
  if (shippingAmount > shippingCost) return "sobra";
  return "ok";
}

function getProductRiskStatus(product, pricing) {
  if (!pricing) return "sem_precificacao";

  const currentPrice = toNumber(product?.price);
  const safePrice = toNumber(pricing?.safe_price);
  const suggestedPrice = toNumber(pricing?.suggested_price);
  const costTotal = toNumber(pricing?.cost_total);
  const realMarginPercent = toNumber(pricing?.real_margin_percent);

  if (costTotal <= 0) return "custo_zerado";

  if (currentPrice > 0 && safePrice > 0 && currentPrice < safePrice) {
    return "abaixo_do_seguro";
  }

  if (currentPrice > 0 && suggestedPrice > 0 && currentPrice < suggestedPrice) {
    return "abaixo_do_sugerido";
  }

  if (realMarginPercent < 10) return "margem_baixa";

  return "saudavel";
}

function getRiskPriority(status) {
  const priorities = {
    abaixo_do_seguro: 1,
    custo_zerado: 2,
    sem_precificacao: 3,
    margem_baixa: 4,
    abaixo_do_sugerido: 5,
    saudavel: 99,
  };

  return priorities[status] || 99;
}

function getRiskLabel(status) {
  const labels = {
    sem_precificacao: "Sem precificação",
    custo_zerado: "Custo zerado",
    abaixo_do_seguro: "Abaixo do preço seguro",
    abaixo_do_sugerido: "Abaixo do preço sugerido",
    margem_baixa: "Margem baixa",
    saudavel: "Saudável",
  };

  return labels[status] || "Em análise";
}

function getRiskReason(status) {
  const reasons = {
    sem_precificacao: "Produto ainda não possui registro de precificação.",
    custo_zerado: "O custo total está zerado ou inconsistente.",
    abaixo_do_seguro:
      "O preço atual está abaixo do preço seguro e exige atenção.",
    abaixo_do_sugerido:
      "O preço atual está abaixo do preço sugerido para a margem desejada.",
    margem_baixa:
      "A margem real está muito baixa e pode comprometer a lucratividade.",
    saudavel: "Produto dentro do cenário ideal de precificação.",
  };

  return reasons[status] || "Sem observações.";
}

function getDirectAffiliateCommission(order) {
  return roundMoney(
    toNumber(order.affiliate_commission_amount) ||
      toNumber(order.affiliate_commission) ||
      toNumber(order.commission_amount) ||
      toNumber(order.affiliate_amount) ||
      toNumber(order.recruitment_bonus_amount) ||
      toNumber(order.network_commission_amount) ||
      toNumber(order.level_bonus_amount) ||
      0
  );
}

function buildCommissionMap(conversions = []) {
  return (conversions || []).reduce((acc, item) => {
    const status = normalizeStatusValue(item.status);

    if (CANCELED_STATUS_VALUES.has(status)) {
      return acc;
    }

    const amount = roundMoney(
      toNumber(item.commission_amount) ||
        toNumber(item.recruitment_bonus_amount) ||
        toNumber(item.network_commission) ||
        toNumber(item.network_commission_amount) ||
        toNumber(item.level_bonus_amount) ||
        toNumber(item.amount) ||
        toNumber(item.commission_value) ||
        0
    );

    if (amount <= 0) {
      return acc;
    }

    const keys = [
      item.order_id,
      item.order_number,
      item.external_reference,
      item.payment_external_reference,
    ].filter(Boolean);

    keys.forEach((key) => {
      const normalizedKey = String(key);
      acc[normalizedKey] = roundMoney(toNumber(acc[normalizedKey]) + amount);
    });

    return acc;
  }, {});
}

function getAffiliateCommissionForOrder(order, commissionMap = {}) {
  const direct = getDirectAffiliateCommission(order);

  if (direct > 0) {
    return direct;
  }

  const keys = [
    order.id,
    order.order_number,
    order.external_reference,
    order.payment_external_reference,
  ].filter(Boolean);

  for (const key of keys) {
    const value = toNumber(commissionMap[String(key)]);

    if (value > 0) {
      return roundMoney(value);
    }
  }

  return 0;
}

function normalizeOrder(order, commissionMap = {}) {
  const grossAmount = getOrderAmount(order);
  const shippingAmount = getShippingChargedAmount(order);
  const shippingCost = getShippingRealCost(order);
  const gatewayFee = getGatewayFee(order);
  const productCost = getProductCost(order);
  const adCost = getAdCost(order);
  const otherCosts = getOtherCosts(order);
  const refundsAmount = getRefundAmount(order);
  const affiliateCommission = getAffiliateCommissionForOrder(order, commissionMap);
  const financialStatus = getFinancialStatus(order);
  const revenueOrder = financialStatus === "paid";

  const totalVariableCosts = roundMoney(
    productCost +
      shippingCost +
      gatewayFee +
      adCost +
      otherCosts +
      refundsAmount +
      affiliateCommission
  );

  const profitBeforeAffiliate = roundMoney(
    grossAmount -
      productCost -
      shippingCost -
      gatewayFee -
      adCost -
      otherCosts -
      refundsAmount
  );

  const calculatedNetProfit = roundMoney(profitBeforeAffiliate - affiliateCommission);

  const netAmount = roundMoney(
    toNumber(order.net_amount) || roundMoney(grossAmount - gatewayFee - refundsAmount)
  );

  const grossProfit = roundMoney(
    toNumber(order.gross_profit) || roundMoney(grossAmount - productCost)
  );

  const netProfit =
    toNumber(order.net_profit) && affiliateCommission <= 0
      ? roundMoney(order.net_profit)
      : calculatedNetProfit;

  const marginPercent =
    grossAmount > 0 ? roundMoney((netProfit / grossAmount) * 100) : 0;

  const shippingDifference = roundMoney(shippingAmount - shippingCost);

  const missingGatewayFee = revenueOrder && grossAmount > 0 && gatewayFee <= 0;
  const missingProductCost = revenueOrder && grossAmount > 0 && productCost <= 0;
  const missingShippingCost = revenueOrder && shippingAmount > 0 && shippingCost <= 0;

  return {
    id: order.id,
    orderNumber:
      order.order_number ||
      order.external_reference ||
      order.payment_external_reference ||
      order.id,
    customerName:
      order.customer_name ||
      order.customer_full_name ||
      order.customer?.full_name ||
      order.customer?.name ||
      "Cliente não identificado",
    createdAt: order.created_at,
    paidAt: order.paid_at || order.payment_approved_at || order.approved_at || null,
    financialDate: getOrderFinancialDate(order),
    status: order.status || order.order_status || order.payment_status || "unknown",
    paymentStatus: order.payment_status || order.payment_raw_status || null,
    orderStatus: order.order_status || order.status || null,
    financialStatus,
    isRevenueOrder: revenueOrder,

    grossAmount: roundMoney(grossAmount),
    shippingAmount: roundMoney(shippingAmount),
    shippingCost: roundMoney(shippingCost),
    shippingDifference,
    shippingRepasseStatus: getShippingRepasseStatus(
      roundMoney(shippingAmount),
      roundMoney(shippingCost)
    ),

    gatewayFee: roundMoney(gatewayFee),
    productCost: roundMoney(productCost),
    adCost: roundMoney(adCost),
    otherCosts: roundMoney(otherCosts),
    refundsAmount: roundMoney(refundsAmount),
    affiliateCommission: roundMoney(affiliateCommission),

    totalVariableCosts,
    netAmount: roundMoney(netAmount),
    grossProfit: roundMoney(grossProfit),
    profitBeforeAffiliate,
    netProfit: roundMoney(netProfit),
    marginPercent: roundMoney(marginPercent),

    missingGatewayFee,
    missingProductCost,
    missingShippingCost,
  };
}
export async function listFinancialCategories(type = "") {
  const filters = ["select=*"];

  if (type) {
    filters.push(`type=eq.${encodeURIComponent(type)}`);
  }

  filters.push("order=name.asc");

  return await supabaseFetch(`financial_categories?${filters.join("&")}`, {
    method: "GET",
  });
}

export async function createFinancialCategory(payload) {
  const body = {
    name: String(payload.name || "").trim(),
    type: String(payload.type || "").trim(),
    color: payload.color || null,
    active: payload.active !== false,
  };

  if (!body.name) {
    throw new Error("Nome da categoria é obrigatório.");
  }

  if (!["income", "expense"].includes(body.type)) {
    throw new Error("Tipo da categoria inválido.");
  }

  const result = await supabaseFetch("financial_categories", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(body),
  });

  return result?.[0] || null;
}

export async function updateFinancialCategory(id, payload) {
  const updates = {};

  if (payload.name !== undefined) updates.name = String(payload.name || "").trim();
  if (payload.type !== undefined) updates.type = String(payload.type || "").trim();
  if (payload.color !== undefined) updates.color = payload.color || null;
  if (payload.active !== undefined) updates.active = !!payload.active;

  const result = await supabaseFetch(`financial_categories?id=eq.${id}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(updates),
  });

  return result?.[0] || null;
}

export async function listAccountsPayable(status = "") {
  const filters = ["select=*"];

  if (status) {
    filters.push(`status=eq.${encodeURIComponent(status)}`);
  }

  filters.push("order=due_date.asc.nullslast");

  return await supabaseFetch(`accounts_payable?${filters.join("&")}`, {
    method: "GET",
  });
}

export async function createAccountPayable(payload) {
  const body = {
    description: String(payload.description || "").trim(),
    category_id: payload.category_id || null,
    supplier_name: payload.supplier_name || null,
    amount: roundMoney(payload.amount),
    due_date: payload.due_date || null,
    paid_date: payload.paid_date || null,
    status: payload.status || "pending",
    payment_method: payload.payment_method || null,
    notes: payload.notes || null,
  };

  if (!body.description) throw new Error("Descrição é obrigatória.");
  if (body.amount <= 0) throw new Error("Valor inválido.");

  const result = await supabaseFetch("accounts_payable", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(body),
  });

  return result?.[0] || null;
}

export async function updateAccountPayable(id, payload) {
  const updates = {};

  if (payload.description !== undefined) {
    updates.description = String(payload.description || "").trim();
  }
  if (payload.category_id !== undefined) updates.category_id = payload.category_id || null;
  if (payload.supplier_name !== undefined) updates.supplier_name = payload.supplier_name || null;
  if (payload.amount !== undefined) updates.amount = roundMoney(payload.amount);
  if (payload.due_date !== undefined) updates.due_date = payload.due_date || null;
  if (payload.paid_date !== undefined) updates.paid_date = payload.paid_date || null;
  if (payload.status !== undefined) updates.status = payload.status || "pending";
  if (payload.payment_method !== undefined) updates.payment_method = payload.payment_method || null;
  if (payload.notes !== undefined) updates.notes = payload.notes || null;

  const result = await supabaseFetch(`accounts_payable?id=eq.${id}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(updates),
  });

  return result?.[0] || null;
}

export async function listAccountsReceivable(status = "") {
  const filters = ["select=*"];

  if (status) {
    filters.push(`status=eq.${encodeURIComponent(status)}`);
  }

  filters.push("order=expected_date.asc.nullslast");

  return await supabaseFetch(`accounts_receivable?${filters.join("&")}`, {
    method: "GET",
  });
}

export async function createAccountReceivable(payload) {
  const body = {
    order_id: payload.order_id || null,
    customer_id: payload.customer_id || null,
    description: String(payload.description || "").trim(),
    amount: roundMoney(payload.amount),
    expected_date: payload.expected_date || null,
    received_date: payload.received_date || null,
    status: payload.status || "pending",
    gateway: payload.gateway || null,
    notes: payload.notes || null,
  };

  if (!body.description) throw new Error("Descrição é obrigatória.");
  if (body.amount <= 0) throw new Error("Valor inválido.");

  const result = await supabaseFetch("accounts_receivable", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(body),
  });

  return result?.[0] || null;
}

export async function updateAccountReceivable(id, payload) {
  const updates = {};

  if (payload.order_id !== undefined) updates.order_id = payload.order_id || null;
  if (payload.customer_id !== undefined) updates.customer_id = payload.customer_id || null;
  if (payload.description !== undefined) {
    updates.description = String(payload.description || "").trim();
  }
  if (payload.amount !== undefined) updates.amount = roundMoney(payload.amount);
  if (payload.expected_date !== undefined) updates.expected_date = payload.expected_date || null;
  if (payload.received_date !== undefined) updates.received_date = payload.received_date || null;
  if (payload.status !== undefined) updates.status = payload.status || "pending";
  if (payload.gateway !== undefined) updates.gateway = payload.gateway || null;
  if (payload.notes !== undefined) updates.notes = payload.notes || null;

  const result = await supabaseFetch(`accounts_receivable?id=eq.${id}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(updates),
  });

  return result?.[0] || null;
}

async function listAffiliateConversionsForPeriod(period = "30d") {
  const { startIso, endIso } = getPeriodRange(period);

  return await optionalSupabaseFetch(
    `affiliate_conversions?select=*&created_at=gte.${encodeURIComponent(
      startIso
    )}&created_at=lte.${encodeURIComponent(endIso)}&order=created_at.desc`,
    { method: "GET" }
  );
}

async function listAffiliateBonusesForPeriod(period = "30d") {
  const { startIso, endIso } = getPeriodRange(period);
  const rows = await optionalSupabaseFetch(
    "affiliate_bonus_overview?select=*&order=released_at.desc.nullslast&limit=1000",
    { method: "GET" }
  );

  return (rows || []).filter((item) => {
    const status = normalizeStatusValue(item.status);

    if (CANCELED_STATUS_VALUES.has(status)) return false;

    const referenceDate =
      item.paid_at || item.approved_at || item.released_at || item.created_at || null;

    return isDateInsideRange(referenceDate, startIso, endIso);
  });
}

function getBonusAmount(item = {}) {
  return roundMoney(
    toNumber(item.bonus_amount) ||
      toNumber(item.amount) ||
      toNumber(item.current_bonus_amount) ||
      0
  );
}

async function listRawOrdersForPeriod(period = "30d") {
  const { startIso, endIso } = getPeriodRange(period);
  const start = encodeURIComponent(startIso);
  const end = encodeURIComponent(endIso);

  const periodQuery =
    `orders?select=*&or=(and(created_at.gte.${start},created_at.lte.${end}),and(paid_at.gte.${start},paid_at.lte.${end}))&order=created_at.desc`;

  const fallbackQuery =
    `orders?select=*&created_at=gte.${start}&created_at=lte.${end}&order=created_at.desc`;

  const rows = await optionalSupabaseFetch(periodQuery, { method: "GET" }, null);

  if (Array.isArray(rows)) {
    return rows;
  }

  return await supabaseFetch(fallbackQuery, { method: "GET" });
}

function filterRevenueOrders(orders = []) {
  return (orders || []).filter((order) => order.isRevenueOrder === true);
}

function filterPaidPayableForPeriod(payable = [], period = "30d") {
  const { startIso, endIso } = getPeriodRange(period);

  return (payable || []).filter((item) => {
    if (normalizeStatusValue(item.status) !== "paid") return false;

    const referenceDate = item.paid_date || item.paid_at || item.created_at || item.due_date;
    return isDateInsideRange(referenceDate, startIso, endIso);
  });
}

async function getFiscalEstimateForRevenue(faturamentoBruto = 0) {
  try {
    const settings = await getFiscalSettings();
    const simplesPercent = toNumber(settings?.estimated_simples_percent, 0);
    const estimatedSimples = roundMoney((toNumber(faturamentoBruto) * simplesPercent) / 100);

    return {
      estimatedSimples,
      simplesPercent,
      source: "fiscal_settings",
    };
  } catch (error) {
    console.warn(
      "FINANCEIRO FISCAL ESTIMATE:",
      error?.message || "Não foi possível estimar impostos."
    );

    return {
      estimatedSimples: 0,
      simplesPercent: 0,
      source: "unavailable",
    };
  }
}

export async function listFinancialOrders(period = "30d") {
  const [orders, conversions] = await Promise.all([
    listRawOrdersForPeriod(period),
    listAffiliateConversionsForPeriod(period),
  ]);

  const commissionMap = buildCommissionMap(conversions);

  return (orders || []).map((order) => normalizeOrder(order, commissionMap));
}

async function getProductsRiskSummary() {
  const [products, pricingRecords] = await Promise.all([
    supabaseFetch(
      "products?select=id,name,sku,price,stock_quantity,status&order=name.asc",
      { method: "GET" }
    ),
    supabaseFetch(
      "product_pricing?select=product_id,cost_total,safe_price,suggested_price,real_margin_percent",
      { method: "GET" }
    ),
  ]);

  const pricingMap = (pricingRecords || []).reduce((acc, item) => {
    acc[item.product_id] = item;
    return acc;
  }, {});

  const enriched = (products || []).map((product) => {
    const pricing = pricingMap[product.id] || null;
    const riskStatus = getProductRiskStatus(product, pricing);

    return {
      productId: product.id,
      name: product.name || "Produto sem nome",
      sku: product.sku || "-",
      currentPrice: roundMoney(product.price),
      stockQuantity: toNumber(product.stock_quantity),
      status: product.status || "active",
      costTotal: roundMoney(pricing?.cost_total),
      safePrice: roundMoney(pricing?.safe_price),
      suggestedPrice: roundMoney(pricing?.suggested_price),
      realMarginPercent: roundMoney(pricing?.real_margin_percent),
      riskStatus,
      riskLabel: getRiskLabel(riskStatus),
      riskReason: getRiskReason(riskStatus),
    };
  });

  const alertItems = enriched
    .filter((item) => item.riskStatus !== "saudavel")
    .sort((a, b) => {
      const priorityDiff =
        getRiskPriority(a.riskStatus) - getRiskPriority(b.riskStatus);

      if (priorityDiff !== 0) return priorityDiff;

      return a.name.localeCompare(b.name, "pt-BR");
    });

  return {
    totalProducts: enriched.length,
    withoutPricing: enriched.filter((item) => item.riskStatus === "sem_precificacao").length,
    zeroCost: enriched.filter((item) => item.riskStatus === "custo_zerado").length,
    belowSafe: enriched.filter((item) => item.riskStatus === "abaixo_do_seguro").length,
    belowSuggested: enriched.filter((item) => item.riskStatus === "abaixo_do_sugerido").length,
    lowMargin: enriched.filter((item) => item.riskStatus === "margem_baixa").length,
    healthy: enriched.filter((item) => item.riskStatus === "saudavel").length,
    alertItems,
  };
}

function buildDre({ orders, payable, faturamentoBruto, receitaLiquida, lucroLiquido, estimatedTaxes = 0, affiliateBonuses = 0 }) {
  const custoProdutos = roundMoney(
    orders.reduce((sum, item) => sum + toNumber(item.productCost), 0)
  );

  const taxasGateway = roundMoney(
    orders.reduce((sum, item) => sum + toNumber(item.gatewayFee), 0)
  );

  const comissoesAfiliados = roundMoney(
    orders.reduce((sum, item) => sum + toNumber(item.affiliateCommission), 0)
  );

  const bonusAfiliados = roundMoney(affiliateBonuses);
  const impostosEstimados = roundMoney(estimatedTaxes);

  const custoTrafego = roundMoney(
    orders.reduce((sum, item) => sum + toNumber(item.adCost), 0)
  );

  const freteReal = roundMoney(
    orders.reduce((sum, item) => sum + toNumber(item.shippingCost), 0)
  );

  const outrasDespesasPedidos = roundMoney(
    orders.reduce(
      (sum, item) =>
        sum + toNumber(item.otherCosts) + toNumber(item.refundsAmount),
      0
    )
  );

  const lucroAntesComissao = roundMoney(
    orders.reduce((sum, item) => sum + toNumber(item.profitBeforeAffiliate), 0)
  );

  const despesasFixasPagas = roundMoney(
    payable
      .filter((item) => normalizeStatusValue(item.status) === "paid")
      .reduce((sum, item) => sum + toNumber(item.amount), 0)
  );

  const totalDespesasOperacionais = roundMoney(
    custoProdutos +
      taxasGateway +
      comissoesAfiliados +
      bonusAfiliados +
      impostosEstimados +
      custoTrafego +
      freteReal +
      outrasDespesasPedidos +
      despesasFixasPagas
  );

  const totalCustosVariaveis = roundMoney(
    custoProdutos +
      taxasGateway +
      comissoesAfiliados +
      bonusAfiliados +
      impostosEstimados +
      custoTrafego +
      freteReal +
      outrasDespesasPedidos
  );

  const base = faturamentoBruto > 0 ? faturamentoBruto : 1;

  const lines = [
    {
      key: "faturamento_bruto",
      label: "Faturamento bruto",
      amount: roundMoney(faturamentoBruto),
      percent: faturamentoBruto > 0 ? 100 : 0,
      type: "positive",
    },
    {
      key: "receita_liquida",
      label: "Receita líquida",
      amount: roundMoney(receitaLiquida),
      percent: roundMoney((receitaLiquida / base) * 100),
      type: "neutral",
    },
    {
      key: "custo_produtos",
      label: "(-) Custo dos produtos vendidos",
      amount: roundMoney(custoProdutos),
      percent: roundMoney((custoProdutos / base) * 100),
      type: "negative",
    },
    {
      key: "taxas_gateway",
      label: "(-) Taxas de pagamento",
      amount: roundMoney(taxasGateway),
      percent: roundMoney((taxasGateway / base) * 100),
      type: "negative",
    },
    {
      key: "comissoes_afiliados",
      label: "(-) Comissões de afiliados",
      amount: roundMoney(comissoesAfiliados),
      percent: roundMoney((comissoesAfiliados / base) * 100),
      type: "negative",
    },
    {
      key: "bonus_afiliados",
      label: "(-) Bônus de metas e níveis",
      amount: roundMoney(bonusAfiliados),
      percent: roundMoney((bonusAfiliados / base) * 100),
      type: "negative",
    },
    {
      key: "impostos_estimados",
      label: "(-) Impostos estimados",
      amount: roundMoney(impostosEstimados),
      percent: roundMoney((impostosEstimados / base) * 100),
      type: "negative",
    },
    {
      key: "custo_trafego",
      label: "(-) Custo de tráfego",
      amount: roundMoney(custoTrafego),
      percent: roundMoney((custoTrafego / base) * 100),
      type: "negative",
    },
    {
      key: "frete_real",
      label: "(-) Frete real / etiquetas",
      amount: roundMoney(freteReal),
      percent: roundMoney((freteReal / base) * 100),
      type: "negative",
    },
    {
      key: "outras_despesas_pedidos",
      label: "(-) Outras despesas e estornos",
      amount: roundMoney(outrasDespesasPedidos),
      percent: roundMoney((outrasDespesasPedidos / base) * 100),
      type: "negative",
    },
    {
      key: "lucro_antes_comissao",
      label: "(=) Lucro antes da comissão",
      amount: roundMoney(lucroAntesComissao),
      percent: roundMoney((lucroAntesComissao / base) * 100),
      type: lucroAntesComissao >= 0 ? "positive" : "danger",
    },
    {
      key: "despesas_fixas_pagas",
      label: "(-) Despesas fixas pagas",
      amount: roundMoney(despesasFixasPagas),
      percent: roundMoney((despesasFixasPagas / base) * 100),
      type: "negative",
    },
    {
      key: "lucro_liquido",
      label: "(=) Lucro líquido real",
      amount: roundMoney(lucroLiquido),
      percent: roundMoney((lucroLiquido / base) * 100),
      type: lucroLiquido >= 0 ? "positive" : "danger",
    },
  ];

  return {
    faturamentoBruto: roundMoney(faturamentoBruto),
    receitaLiquida: roundMoney(receitaLiquida),
    custoProdutos,
    taxasGateway,
    comissoesAfiliados,
    bonusAfiliados,
    impostosEstimados,
    custoTrafego,
    freteReal,
    outrasDespesasPedidos,
    lucroAntesComissao,
    despesasFixasPagas,
    totalCustosVariaveis,
    totalDespesasOperacionais,
    lucroLiquido: roundMoney(lucroLiquido),
    margemFinal:
      faturamentoBruto > 0
        ? roundMoney((lucroLiquido / faturamentoBruto) * 100)
        : 0,
    lines,
  };
}

export async function getFinancialSummary(period = "30d") {
  const [allOrders, payable, receivable, productsRisk, bonusRows] = await Promise.all([
    listFinancialOrders(period),
    listAccountsPayable(),
    listAccountsReceivable(),
    getProductsRiskSummary(),
    listAffiliateBonusesForPeriod(period),
  ]);

  const orders = filterRevenueOrders(allOrders);
  const paidPayableForPeriod = filterPaidPayableForPeriod(payable, period);
  const affiliateBonuses = roundMoney(
    (bonusRows || []).reduce((sum, item) => sum + getBonusAmount(item), 0)
  );

  const faturamentoBruto = orders.reduce(
    (sum, item) => sum + toNumber(item.grossAmount),
    0
  );

  const receitaLiquida = orders.reduce(
    (sum, item) => sum + toNumber(item.netAmount),
    0
  );

  const fiscalEstimate = await getFiscalEstimateForRevenue(faturamentoBruto);
  const estimatedTaxes = roundMoney(fiscalEstimate.estimatedSimples);

  const lucroLiquidoAntesFixas = orders.reduce(
    (sum, item) => sum + toNumber(item.netProfit),
    0
  );

  const despesasFixasPagasPeriodo = paidPayableForPeriod.reduce(
    (sum, item) => sum + toNumber(item.amount),
    0
  );

  const lucroLiquido = roundMoney(
    lucroLiquidoAntesFixas - despesasFixasPagasPeriodo - affiliateBonuses - estimatedTaxes
  );

  const despesasPedidos = orders.reduce((sum, item) => {
    return sum + toNumber(item.totalVariableCosts);
  }, 0);

  const totalGatewayFees = orders.reduce(
    (sum, item) => sum + toNumber(item.gatewayFee),
    0
  );

  const totalAffiliateCommissions = orders.reduce(
    (sum, item) => sum + toNumber(item.affiliateCommission),
    0
  );

  const totalProductCosts = orders.reduce(
    (sum, item) => sum + toNumber(item.productCost),
    0
  );

  const totalAdCosts = orders.reduce(
    (sum, item) => sum + toNumber(item.adCost),
    0
  );

  const totalOtherCosts = orders.reduce(
    (sum, item) => sum + toNumber(item.otherCosts) + toNumber(item.refundsAmount),
    0
  );

  const totalShippingCharged = orders.reduce(
    (sum, item) => sum + toNumber(item.shippingAmount),
    0
  );

  const totalShippingReal = orders.reduce(
    (sum, item) => sum + toNumber(item.shippingCost),
    0
  );

  const shippingDifference = roundMoney(totalShippingCharged - totalShippingReal);

  const shippingToReplenish = roundMoney(
    totalShippingReal > totalShippingCharged
      ? totalShippingReal - totalShippingCharged
      : 0
  );

  const shippingSurplus = roundMoney(
    totalShippingCharged > totalShippingReal
      ? totalShippingCharged - totalShippingReal
      : 0
  );

  const contasPagarPendentes = payable
    .filter((item) => ["pending", "overdue"].includes(normalizeStatusValue(item.status)))
    .reduce((sum, item) => sum + toNumber(item.amount), 0);

  const contasPagarPagas = despesasFixasPagasPeriodo;

  const contasReceberPendentes = receivable
    .filter((item) => ["pending", "overdue"].includes(normalizeStatusValue(item.status)))
    .reduce((sum, item) => sum + toNumber(item.amount), 0);

  const despesasTotais = roundMoney(
    despesasPedidos + contasPagarPagas + affiliateBonuses + estimatedTaxes
  );

  const margem =
    faturamentoBruto > 0
      ? roundMoney((lucroLiquido / faturamentoBruto) * 100)
      : 0;

  const ticketMedio =
    orders.length > 0 ? roundMoney(faturamentoBruto / orders.length) : 0;

  const overdueBills =
    payable.filter((item) => normalizeStatusValue(item.status) === "overdue").length +
    receivable.filter((item) => normalizeStatusValue(item.status) === "overdue").length;

  const ordersWithLoss = orders.filter((item) => toNumber(item.netProfit) < 0).length;
  const pedidosPagos = orders.length;
  const pedidosPendentes = allOrders.filter((item) => item.financialStatus === "pending").length;
  const pedidosCancelados = allOrders.filter((item) => item.financialStatus === "canceled").length;
  const ordersWithoutGatewayFee = orders.filter((item) => item.missingGatewayFee).length;
  const ordersWithoutProductCost = orders.filter((item) => item.missingProductCost).length;
  const ordersWithoutShippingCost = orders.filter((item) => item.missingShippingCost).length;

  const dre = buildDre({
    orders,
    payable: paidPayableForPeriod,
    faturamentoBruto,
    receitaLiquida,
    lucroLiquido,
    estimatedTaxes,
    affiliateBonuses,
  });

  return {
    period,
    calculationPolicy: {
      revenue: "Somente pedidos pagos/aprovados entram no faturamento, lucro, frete e custos.",
      excludedOrders: "Pedidos pendentes/cancelados aparecem na aba de pedidos, mas ficam fora dos cards e DRE.",
      taxes: "Impostos são estimados pela configuração fiscal e devem ser validados pelo contador.",
    },
    cards: {
      faturamentoBruto: roundMoney(faturamentoBruto),
      receitaLiquida: roundMoney(receitaLiquida),
      despesasTotais,
      lucroLiquido: roundMoney(lucroLiquido),
      margem,
      ticketMedio,
      contasReceber: roundMoney(contasReceberPendentes),
      contasPagar: roundMoney(contasPagarPendentes),
    },
    costs: {
      totalGatewayFees: roundMoney(totalGatewayFees),
      totalAffiliateCommissions: roundMoney(totalAffiliateCommissions),
      totalAffiliateBonuses: roundMoney(affiliateBonuses),
      estimatedTaxes: roundMoney(estimatedTaxes),
      estimatedTaxPercent: roundMoney(fiscalEstimate.simplesPercent),
      totalProductCosts: roundMoney(totalProductCosts),
      totalShippingReal: roundMoney(totalShippingReal),
      totalAdCosts: roundMoney(totalAdCosts),
      totalOtherCosts: roundMoney(totalOtherCosts),
      totalVariableCosts: roundMoney(despesasPedidos + affiliateBonuses + estimatedTaxes),
      fixedExpensesPaid: roundMoney(contasPagarPagas),
      totalCostsWithFixedExpenses: roundMoney(despesasTotais),
      ordersWithoutGatewayFee,
      ordersWithoutProductCost,
      ordersWithoutShippingCost,
    },
    shipping: {
      totalCharged: roundMoney(totalShippingCharged),
      totalReal: roundMoney(totalShippingReal),
      difference: shippingDifference,
      toReplenish: shippingToReplenish,
      surplus: shippingSurplus,
    },
    dre,
    highlights: {
      pedidosPagos,
      pedidosPendentes,
      pedidosCancelados,
      totalOrdersInPeriod: allOrders.length,
      revenueOrdersInPeriod: orders.length,
      excludedOrdersFromRevenue: allOrders.length - orders.length,
      overdueBills,
      ordersWithLoss,
      ordersWithoutGatewayFee,
      ordersWithoutProductCost,
      ordersWithoutShippingCost,
      productsWithoutPricing: productsRisk.withoutPricing,
      productsBelowSafe: productsRisk.belowSafe,
      productsBelowSuggested: productsRisk.belowSuggested,
      productsZeroCost: productsRisk.zeroCost,
      productsLowMargin: productsRisk.lowMargin,
      healthyProducts: productsRisk.healthy,
    },
    productAlerts: productsRisk.alertItems,
  };
}

async function listAffiliateConversionsForOrder(order = {}) {
  const keys = [
    order.id,
    order.order_number,
    order.external_reference,
    order.payment_external_reference,
  ].filter(Boolean);

  if (!keys.length) return [];

  const safeKeys = keys.map((key) => String(key).replace(/"/g, ""));
  const orParts = safeKeys.flatMap((key) => [
    `order_id.eq.${encodeURIComponent(key)}`,
    `order_number.eq.${encodeURIComponent(key)}`,
    `external_reference.eq.${encodeURIComponent(key)}`,
    `payment_external_reference.eq.${encodeURIComponent(key)}`,
  ]);

  return await optionalSupabaseFetch(
    `affiliate_conversions?select=*&or=(${orParts.join(",")})&order=created_at.desc`,
    { method: "GET" }
  );
}

export async function syncOrderFinancialData(orderId) {
  const orders = await supabaseFetch(
    `orders?select=*&id=eq.${orderId}&limit=1`,
    {
      method: "GET",
    }
  );

  const order = orders?.[0];

  if (!order) {
    throw new Error("Pedido não encontrado.");
  }

  const conversions = await listAffiliateConversionsForOrder(order);
  const commissionMap = buildCommissionMap(conversions);
  const normalized = normalizeOrder(order, commissionMap);

  const updates = {
    gross_amount: normalized.grossAmount,
    net_amount: normalized.netAmount,
    gross_profit: normalized.grossProfit,
    net_profit: normalized.netProfit,
    margin_percent: normalized.marginPercent,
    financial_status: normalized.financialStatus,
  };

  const result = await supabaseFetch(`orders?id=eq.${orderId}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(updates),
  });

  return result?.[0] || null;
}

export default {
  listFinancialCategories,
  createFinancialCategory,
  updateFinancialCategory,
  listAccountsPayable,
  createAccountPayable,
  updateAccountPayable,
  listAccountsReceivable,
  createAccountReceivable,
  updateAccountReceivable,
  listFinancialOrders,
  getFinancialSummary,
  syncOrderFinancialData,
};