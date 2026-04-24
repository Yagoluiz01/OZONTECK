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

function normalizeOrder(order) {
  const grossAmount =
    toNumber(order.gross_amount) ||
    toNumber(order.total_amount) ||
    toNumber(order.total) ||
    toNumber(order.amount) ||
    toNumber(order.total_price) ||
    0;

  const shippingAmount = toNumber(order.shipping_amount);
  const shippingCost = toNumber(order.shipping_cost);
  const gatewayFee = toNumber(order.gateway_fee);
  const productCost = toNumber(order.product_cost);
  const adCost = toNumber(order.ad_cost);
  const otherCosts = toNumber(order.other_costs);
  const refundsAmount = toNumber(order.refunds_amount);

  const netAmount =
    toNumber(order.net_amount) ||
    roundMoney(grossAmount - gatewayFee - refundsAmount);

  const grossProfit =
    toNumber(order.gross_profit) ||
    roundMoney(grossAmount - productCost);

  const netProfit =
    toNumber(order.net_profit) ||
    roundMoney(
      grossAmount -
        productCost -
        shippingCost -
        gatewayFee -
        adCost -
        otherCosts -
        refundsAmount
    );

  const marginPercent =
    toNumber(order.margin_percent) ||
    (grossAmount > 0 ? roundMoney((netProfit / grossAmount) * 100) : 0);

  const shippingDifference = roundMoney(shippingAmount - shippingCost);

  return {
    id: order.id,
    orderNumber:
      order.order_number ||
      order.external_reference ||
      order.payment_external_reference ||
      order.id,
    customerName:
      order.customer_name ||
      order.customer?.full_name ||
      order.customer?.name ||
      "Cliente não identificado",
    createdAt: order.created_at,
    status: order.status || "unknown",
    financialStatus:
      order.financial_status ||
      (["paid", "approved", "completed"].includes(
        String(order.status || "").toLowerCase()
      )
        ? "paid"
        : "pending"),
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
    netAmount: roundMoney(netAmount),
    grossProfit: roundMoney(grossProfit),
    netProfit: roundMoney(netProfit),
    marginPercent: roundMoney(marginPercent),
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

export async function listFinancialOrders(period = "30d") {
  const { startIso, endIso } = getPeriodRange(period);

  const orders = await supabaseFetch(
    `orders?select=*&created_at=gte.${encodeURIComponent(
      startIso
    )}&created_at=lte.${encodeURIComponent(endIso)}&order=created_at.desc`,
    {
      method: "GET",
    }
  );

  return (orders || []).map(normalizeOrder);
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

function buildDre({ orders, payable, faturamentoBruto, receitaLiquida, lucroLiquido }) {
  const custoProdutos = roundMoney(
    orders.reduce((sum, item) => sum + toNumber(item.productCost), 0)
  );

  const taxasGateway = roundMoney(
    orders.reduce((sum, item) => sum + toNumber(item.gatewayFee), 0)
  );

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

  const despesasFixasPagas = roundMoney(
    payable
      .filter((item) => item.status === "paid")
      .reduce((sum, item) => sum + toNumber(item.amount), 0)
  );

  const totalDespesasOperacionais = roundMoney(
    custoProdutos +
      taxasGateway +
      custoTrafego +
      freteReal +
      outrasDespesasPedidos +
      despesasFixasPagas
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
      label: "(-) Custo dos produtos",
      amount: roundMoney(custoProdutos),
      percent: roundMoney((custoProdutos / base) * 100),
      type: "negative",
    },
    {
      key: "taxas_gateway",
      label: "(-) Taxas de gateway",
      amount: roundMoney(taxasGateway),
      percent: roundMoney((taxasGateway / base) * 100),
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
      label: "(-) Frete real",
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
      key: "despesas_fixas_pagas",
      label: "(-) Despesas fixas pagas",
      amount: roundMoney(despesasFixasPagas),
      percent: roundMoney((despesasFixasPagas / base) * 100),
      type: "negative",
    },
    {
      key: "lucro_liquido",
      label: "(=) Lucro líquido",
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
    custoTrafego,
    freteReal,
    outrasDespesasPedidos,
    despesasFixasPagas,
    totalDespesasOperacionais,
    lucroLiquido: roundMoney(lucroLiquido),
    margemFinal: faturamentoBruto > 0 ? roundMoney((lucroLiquido / faturamentoBruto) * 100) : 0,
    lines,
  };
}

export async function getFinancialSummary(period = "30d") {
  const [orders, payable, receivable, productsRisk] = await Promise.all([
    listFinancialOrders(period),
    listAccountsPayable(),
    listAccountsReceivable(),
    getProductsRiskSummary(),
  ]);

  const faturamentoBruto = orders.reduce(
    (sum, item) => sum + toNumber(item.grossAmount),
    0
  );

  const receitaLiquida = orders.reduce(
    (sum, item) => sum + toNumber(item.netAmount),
    0
  );

  const lucroLiquido = orders.reduce(
    (sum, item) => sum + toNumber(item.netProfit),
    0
  );

  const despesasPedidos = orders.reduce((sum, item) => {
    return (
      sum +
      toNumber(item.productCost) +
      toNumber(item.shippingCost) +
      toNumber(item.gatewayFee) +
      toNumber(item.adCost) +
      toNumber(item.otherCosts) +
      toNumber(item.refundsAmount)
    );
  }, 0);

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
    .filter((item) => item.status === "pending" || item.status === "overdue")
    .reduce((sum, item) => sum + toNumber(item.amount), 0);

  const contasPagarPagas = payable
    .filter((item) => item.status === "paid")
    .reduce((sum, item) => sum + toNumber(item.amount), 0);

  const contasReceberPendentes = receivable
    .filter((item) => item.status === "pending" || item.status === "overdue")
    .reduce((sum, item) => sum + toNumber(item.amount), 0);

  const despesasTotais = roundMoney(despesasPedidos + contasPagarPagas);

  const margem =
    faturamentoBruto > 0
      ? roundMoney((lucroLiquido / faturamentoBruto) * 100)
      : 0;

  const ticketMedio =
    orders.length > 0 ? roundMoney(faturamentoBruto / orders.length) : 0;

  const overdueBills =
    payable.filter((item) => item.status === "overdue").length +
    receivable.filter((item) => item.status === "overdue").length;

  const ordersWithLoss = orders.filter((item) => toNumber(item.netProfit) < 0).length;
  const pedidosPagos = orders.filter((item) => item.financialStatus === "paid").length;
  const pedidosPendentes = orders.filter((item) => item.financialStatus !== "paid").length;

  const dre = buildDre({
    orders,
    payable,
    faturamentoBruto,
    receitaLiquida,
    lucroLiquido,
  });

  return {
    period,
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
      overdueBills,
      ordersWithLoss,
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

  const normalized = normalizeOrder(order);

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