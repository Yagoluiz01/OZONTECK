const env = globalThis.env || {};

const SUPABASE_URL =
  env.supabaseUrl ||
  process.env.SUPABASE_URL ||
  process.env.NEXT_PUBLIC_SUPABASE_URL;

const SUPABASE_SERVICE_ROLE_KEY =
  env.supabaseServiceRoleKey ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY;

const SIMPLES_ANEXO_I_TABLE = [
  { limit: 180000, rate: 4, deduction: 0 },
  { limit: 360000, rate: 7.3, deduction: 5940 },
  { limit: 720000, rate: 9.5, deduction: 13860 },
  { limit: 1800000, rate: 10.7, deduction: 22500 },
  { limit: 3600000, rate: 14.3, deduction: 87300 },
  { limit: 4800000, rate: 19, deduction: 378000 },
];

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

function formatCurrencyBRL(value) {
  return Number(value || 0).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

function normalizePercent(value) {
  const percent = toNumber(value, 0);

  if (percent < 0) return 0;
  if (percent > 100) return 100;

  return percent;
}


function calculateSimplesAnexoIEffectiveTax(revenue12mInput) {
  const revenue12m = toNumber(revenue12mInput, 0);

  if (revenue12m <= 0) {
    return {
      effective_percent: 4,
      nominal_percent: 4,
      deduction: 0,
      revenue_12m: 0,
      bracket_label: "1ª faixa • até R$ 180 mil",
      warning: "Sem faturamento informado, foi usada a primeira faixa do Simples Nacional Comércio como estimativa inicial.",
    };
  }

  const bracketIndex = SIMPLES_ANEXO_I_TABLE.findIndex((item) => revenue12m <= item.limit);
  const bracket = bracketIndex >= 0
    ? SIMPLES_ANEXO_I_TABLE[bracketIndex]
    : SIMPLES_ANEXO_I_TABLE[SIMPLES_ANEXO_I_TABLE.length - 1];

  const effectivePercent = ((revenue12m * (bracket.rate / 100) - bracket.deduction) / revenue12m) * 100;
  const safeEffectivePercent = normalizePercent(effectivePercent);

  return {
    effective_percent: roundMoney(safeEffectivePercent),
    nominal_percent: roundMoney(bracket.rate),
    deduction: roundMoney(bracket.deduction),
    revenue_12m: roundMoney(revenue12m),
    bracket_label: `${bracketIndex >= 0 ? bracketIndex + 1 : 6}ª faixa • até ${formatCurrencyBRL(bracket.limit)}`,
    warning: revenue12m > 4800000
      ? "Receita acima do limite anual do Simples Nacional. Confirme com o contador antes de usar na precificação."
      : null,
  };
}

function resolveTaxPercent(input = {}) {
  const manualTaxPercent = normalizePercent(input.tax_percent);

  if (manualTaxPercent > 0) {
    return {
      tax_percent: manualTaxPercent,
      source: "manual",
      automation: null,
    };
  }

  const automationEnabled = normalizeBoolean(input.tax_automation_enabled ?? input.auto_tax_enabled, false);
  const regime = String(input.tax_regime || "").trim().toLowerCase();
  const annex = String(input.tax_annex || "").trim().toLowerCase();

  const isSimplesMe = automationEnabled && (!regime || regime.includes("simples") || regime.includes("me"));
  const isAnexoI = !annex || annex.includes("anexo_i") || annex.includes("comercio") || annex.includes("comércio");

  if (isSimplesMe && isAnexoI) {
    const automation = calculateSimplesAnexoIEffectiveTax(input.tax_revenue_12m ?? input.revenue_12m);
    return {
      tax_percent: automation.effective_percent,
      source: "simples_anexo_i_auto",
      automation,
    };
  }

  return {
    tax_percent: 0,
    source: "none",
    automation: null,
  };
}

function normalizeBoolean(value, fallback = true) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (["false", "0", "no", "nao", "não", "inactive", "inativo"].includes(normalized)) {
    return false;
  }
  return true;
}

function normalizeGoalLevel(row = {}) {
  const requiredConversions = Math.trunc(
    toNumber(
      row.required_conversions ?? row.requiredConversions ?? row.sales_required ?? row.conversions_required,
      0
    )
  );

  const bonusAmount = roundMoney(
    row.bonus_amount ?? row.bonusAmount ?? row.amount ?? row.reward_amount ?? 0
  );

  return {
    id: row.id || null,
    level_order: Math.trunc(toNumber(row.level_order ?? row.levelOrder ?? row.order, 0)),
    name: String(row.name || row.level_name || row.title || "Meta").trim() || "Meta",
    required_conversions: requiredConversions > 0 ? requiredConversions : 0,
    bonus_amount: bonusAmount > 0 ? bonusAmount : 0,
    bonus_type: row.bonus_type || row.bonusType || "fixed",
    badge_color: row.badge_color || row.badgeColor || "#16d45d",
    description: row.description || "",
    is_active: normalizeBoolean(row.is_active ?? row.active ?? row.enabled, true),
  };
}

function isFixedGoalBonus(level = {}) {
  const type = String(level.bonus_type || "fixed").trim().toLowerCase();
  return ["fixed", "money", "cash", "valor_fixo", "fixed_amount", "currency"].includes(type);
}

function buildGoalLevelsAnalysis(levelRows = []) {
  const levels = (Array.isArray(levelRows) ? levelRows : [])
    .map(normalizeGoalLevel)
    .filter((level) => level.is_active && level.required_conversions > 0 && level.bonus_amount > 0)
    .sort((a, b) => {
      if (a.level_order !== b.level_order) return a.level_order - b.level_order;
      return a.required_conversions - b.required_conversions;
    });

  let accumulatedBonus = 0;

  const normalizedLevels = levels.map((level) => {
    const fixedBonus = isFixedGoalBonus(level) ? level.bonus_amount : 0;
    accumulatedBonus = roundMoney(accumulatedBonus + fixedBonus);
    const bonusPerSale = level.required_conversions > 0
      ? roundMoney(accumulatedBonus / level.required_conversions)
      : 0;

    return {
      ...level,
      accumulated_bonus_amount: accumulatedBonus,
      bonus_per_sale: bonusPerSale,
    };
  });

  const worstLevel = normalizedLevels.reduce((worst, level) => {
    if (!worst || level.bonus_per_sale > worst.bonus_per_sale) return level;
    return worst;
  }, null);

  return {
    levels: normalizedLevels,
    worst_level: worstLevel,
    worst_bonus_per_sale: roundMoney(worstLevel?.bonus_per_sale || 0),
  };
}


function resolveManualGoalBonusPerSale(input = {}) {
  const explicitPerSale = roundMoney(
    input.goal_bonus_per_sale ??
      input.goalBonusPerSale ??
      input.bonus_per_sale ??
      input.bonusPerSale ??
      0
  );

  if (explicitPerSale > 0) {
    return {
      value: explicitPerSale,
      source: "manual_per_sale",
      total_bonus_amount: 0,
      required_conversions: 0,
      warning: null,
    };
  }

  const totalBonusAmount = roundMoney(
    input.goal_bonus_amount ??
      input.goalBonusAmount ??
      input.goal_bonus_value ??
      input.goalBonusValue ??
      input.bonus_amount ??
      input.bonusAmount ??
      0
  );

  const requiredConversions = Math.trunc(
    toNumber(
      input.goal_required_conversions ??
        input.goalRequiredConversions ??
        input.required_conversions ??
        input.requiredConversions ??
        input.minimum_sales ??
        input.minimumSales ??
        input.sales_required ??
        input.salesRequired ??
        0,
      0
    )
  );

  if (totalBonusAmount > 0 && requiredConversions > 0) {
    return {
      value: roundMoney(totalBonusAmount / requiredConversions),
      source: "manual_total_divided_by_goal",
      total_bonus_amount: totalBonusAmount,
      required_conversions: requiredConversions,
      warning: null,
    };
  }

  if (totalBonusAmount > 0) {
    return {
      value: 0,
      source: "manual_total_ignored_without_goal",
      total_bonus_amount: totalBonusAmount,
      required_conversions: 0,
      warning:
        "Bônus total de meta informado sem quantidade mínima de vendas. Para evitar encarecer uma unidade, esse valor não foi embutido como custo unitário.",
    };
  }

  return {
    value: 0,
    source: "none",
    total_bonus_amount: 0,
    required_conversions: 0,
    warning: null,
  };
}


function sumAffiliatePercent({ directCommissionPercent = 0, networkCommissionPercent = 0 } = {}) {
  return Math.min(
    normalizePercent(directCommissionPercent) + normalizePercent(networkCommissionPercent),
    100
  );
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

function normalizeInstallmentInterestPolicy(value) {
  const policy = String(value || "customer_pays").trim().toLowerCase();

  if (["merchant_absorbs", "store_absorbs", "absorver", "loja_absorve"].includes(policy)) {
    return "merchant_absorbs";
  }

  return "customer_pays";
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
  networkCommissionPercent = 0,
  fixedAffiliateCost = 0,
  marginPercent,
}) {
  const variablePercent =
    normalizePercent(gatewayFeePercent) / 100 +
    normalizePercent(taxPercent) / 100 +
    sumAffiliatePercent({
      directCommissionPercent: commissionPercent,
      networkCommissionPercent,
    }) / 100 +
    normalizePercent(marginPercent) / 100;

  if (variablePercent >= 1) {
    return 0;
  }

  return roundMoney((baseCost + roundMoney(fixedAffiliateCost)) / (1 - variablePercent));
}

function calculateProfitForPrice({
  price,
  baseCost,
  gatewayFeePercent,
  taxPercent,
  commissionPercent,
  networkCommissionPercent = 0,
  fixedAffiliateCost = 0,
}) {
  const safePrice = roundMoney(price);
  const gatewayValue = roundMoney(
    safePrice * (normalizePercent(gatewayFeePercent) / 100)
  );

  const taxValue = roundMoney(safePrice * (normalizePercent(taxPercent) / 100));

  const commissionValue = roundMoney(
    safePrice * (normalizePercent(commissionPercent) / 100)
  );

  const networkCommissionValue = roundMoney(
    safePrice * (normalizePercent(networkCommissionPercent) / 100)
  );

  const goalBonusValue = roundMoney(fixedAffiliateCost);

  const affiliateTotalCost = roundMoney(
    commissionValue + networkCommissionValue + goalBonusValue
  );

  const profit = roundMoney(
    safePrice - baseCost - gatewayValue - taxValue - affiliateTotalCost
  );

  const marginPercent = safePrice > 0 ? roundMoney((profit / safePrice) * 100) : 0;

  return {
    gateway_value: gatewayValue,
    tax_value: taxValue,
    commission_value: commissionValue,
    network_commission_value: networkCommissionValue,
    goal_bonus_value: goalBonusValue,
    affiliate_total_cost: affiliateTotalCost,
    profit,
    margin_percent: marginPercent,
  };
}


function calculateSafeDirectCommissionForPrice({
  price,
  baseCost,
  gatewayFeePercent,
  taxPercent,
  networkCommissionPercent = 0,
  fixedAffiliateCost = 0,
  minimumCompanyMarginPercent = 0,
}) {
  const safePrice = roundMoney(price);

  if (!safePrice || safePrice <= 0) {
    return {
      reference_price: 0,
      gateway_value: 0,
      tax_value: 0,
      network_commission_value: 0,
      goal_bonus_value: 0,
      minimum_company_profit_value: 0,
      fixed_cost_total: roundMoney(baseCost),
      protected_cost_total: roundMoney(baseCost),
      safe_commission_value: 0,
      safe_commission_percent: 0,
      available_before_direct_commission: 0,
      has_available_margin: false,
    };
  }

  const gatewayValue = roundMoney(
    safePrice * (normalizePercent(gatewayFeePercent) / 100)
  );

  const taxValue = roundMoney(
    safePrice * (normalizePercent(taxPercent) / 100)
  );

  const networkCommissionValue = roundMoney(
    safePrice * (normalizePercent(networkCommissionPercent) / 100)
  );

  const goalBonusValue = roundMoney(fixedAffiliateCost);

  const minimumCompanyProfitValue = roundMoney(
    safePrice * (normalizePercent(minimumCompanyMarginPercent) / 100)
  );

  const fixedCostTotal = roundMoney(baseCost);

  const protectedCostTotal = roundMoney(
    fixedCostTotal +
      gatewayValue +
      taxValue +
      networkCommissionValue +
      goalBonusValue +
      minimumCompanyProfitValue
  );

  const availableBeforeDirectCommission = roundMoney(
    safePrice - protectedCostTotal
  );

  const safeCommissionValue = roundMoney(
    Math.max(availableBeforeDirectCommission, 0)
  );

  const safeCommissionPercent =
    safePrice > 0 ? roundMoney((safeCommissionValue / safePrice) * 100) : 0;

  return {
    reference_price: safePrice,
    gateway_value: gatewayValue,
    tax_value: taxValue,
    network_commission_value: networkCommissionValue,
    goal_bonus_value: goalBonusValue,
    minimum_company_profit_value: minimumCompanyProfitValue,
    fixed_cost_total: fixedCostTotal,
    protected_cost_total: protectedCostTotal,
    safe_commission_value: safeCommissionValue,
    safe_commission_percent: normalizePercent(safeCommissionPercent),
    available_before_direct_commission: availableBeforeDirectCommission,
    has_available_margin: safeCommissionValue > 0,
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
        "A comissão padrão informada é muito alta para a margem atual. Aumente o preço, reduza custos ou reduza a comissão.",
    };
  }

  if (profitWithMaxCommission <= 0) {
    return {
      status: "loss",
      risk_message:
        "Com a comissão padrão, este produto pode dar prejuízo. Revise o preço, os custos ou a comissão antes de liberar para afiliados.",
    };
  }

  if (marginWithMaxCommissionPercent < minimumCompanyMarginPercent) {
    return {
      status: "attention",
      risk_message:
        "Com a comissão padrão, a margem da empresa fica abaixo do mínimo definido.",
    };
  }


  return {
    status: "healthy",
    risk_message:
      "Precificação saudável. O produto suporta os custos e a comissão configurada.",
  };
}

function buildGoalAnalysisForPricing({
  goalLevels = [],
  baseCost,
  gatewayFeePercent,
  taxPercent,
  affiliateCommissionPercent,
  maxAffiliateCommissionPercent,
  specialAffiliateCommissionPercent,
  networkCommissionPercent,
  minimumCompanyMarginPercent,
  suggestedPrice,
  currentProductPrice = 0,
}) {
  const baseGoalAnalysis = buildGoalLevelsAnalysis(goalLevels);

  const levels = baseGoalAnalysis.levels.map((level) => {
    const requiredDefaultPrice = calculatePriceForCommission({
      baseCost,
      gatewayFeePercent,
      taxPercent,
      commissionPercent: affiliateCommissionPercent,
      networkCommissionPercent,
      fixedAffiliateCost: level.bonus_per_sale,
      marginPercent: minimumCompanyMarginPercent,
    });

    const requiredSpecialPrice = calculatePriceForCommission({
      baseCost,
      gatewayFeePercent,
      taxPercent,
      commissionPercent: specialAffiliateCommissionPercent,
      networkCommissionPercent,
      fixedAffiliateCost: level.bonus_per_sale,
      marginPercent: minimumCompanyMarginPercent,
    });

    const requiredMaxPrice = calculatePriceForCommission({
      baseCost,
      gatewayFeePercent,
      taxPercent,
      commissionPercent: maxAffiliateCommissionPercent,
      networkCommissionPercent,
      fixedAffiliateCost: level.bonus_per_sale,
      marginPercent: minimumCompanyMarginPercent,
    });

    const suggestedProfit = calculateProfitForPrice({
      price: suggestedPrice,
      baseCost,
      gatewayFeePercent,
      taxPercent,
      commissionPercent: affiliateCommissionPercent,
      networkCommissionPercent,
      fixedAffiliateCost: level.bonus_per_sale,
    });

    const currentProfit = calculateProfitForPrice({
      price: currentProductPrice,
      baseCost,
      gatewayFeePercent,
      taxPercent,
      commissionPercent: affiliateCommissionPercent,
      networkCommissionPercent,
      fixedAffiliateCost: level.bonus_per_sale,
    });

    return {
      ...level,
      required_price_default: roundMoney(requiredDefaultPrice),
      required_price_special: roundMoney(requiredSpecialPrice),
      required_price_max: roundMoney(requiredMaxPrice),
      suggested_profit: roundMoney(suggestedProfit.profit),
      suggested_margin_percent: roundMoney(suggestedProfit.margin_percent),
      current_profit: roundMoney(currentProfit.profit),
      current_margin_percent: roundMoney(currentProfit.margin_percent),
      safe_at_suggested_price:
        suggestedProfit.profit > 0 &&
        suggestedProfit.margin_percent >= minimumCompanyMarginPercent,
      safe_at_current_price:
        currentProductPrice > 0 &&
        currentProfit.profit > 0 &&
        currentProfit.margin_percent >= minimumCompanyMarginPercent,
    };
  });

  const recommendedLevel = [...levels]
    .filter((level) => level.safe_at_suggested_price)
    .sort((a, b) => {
      if (a.level_order !== b.level_order) return b.level_order - a.level_order;
      return b.required_conversions - a.required_conversions;
    })[0] || null;

  const currentRecommendedLevel = [...levels]
    .filter((level) => level.safe_at_current_price)
    .sort((a, b) => {
      if (a.level_order !== b.level_order) return b.level_order - a.level_order;
      return b.required_conversions - a.required_conversions;
    })[0] || null;

  const unsafeLevels = levels.filter((level) => !level.safe_at_suggested_price);
  const safeLevels = levels.filter((level) => level.safe_at_suggested_price);

  return {
    mode: "auto_worst_goal_per_sale",
    explanation:
      "A precificação usa o maior custo médio de bônus por venda entre as metas ativas. A meta continua sendo do afiliado, mas cada produto mostra até qual nível consegue sustentar.",
    level_count: levels.length,
    safe_level_count: safeLevels.length,
    unsafe_level_count: unsafeLevels.length,
    worst_level: baseGoalAnalysis.worst_level,
    worst_bonus_per_sale: roundMoney(baseGoalAnalysis.worst_bonus_per_sale),
    recommended_level: recommendedLevel,
    current_recommended_level: currentRecommendedLevel,
    levels,
  };
}

function calculatePricing(input, goalLevels = [], product = null) {
  const costPrice = roundMoney(input.cost_price);
  const packagingCost = roundMoney(input.packaging_cost);
  const trafficCost = roundMoney(input.traffic_cost);
  const gatewayFeePercent = normalizePercent(input.gateway_fee_percent);
  const taxResolution = resolveTaxPercent(input);
  const taxPercent = taxResolution.tax_percent;
  const otherCosts = roundMoney(input.other_costs);
  const desiredMarginPercent = normalizePercent(input.desired_margin_percent);
  const averageShippingCost = roundMoney(input.average_shipping_cost);
  const shippingPolicy = input.shipping_policy || "customer_paid";

  const affiliateCommissionPercent = normalizePercent(
    getAutoPercent(input.affiliate_commission_percent, 10)
  );

  // A precificação agora trabalha somente com 2 comissões:
  // 1) comissão padrão do afiliado vendedor; 2) comissão de rede/recrutamento.
  // Mantemos os campos de máxima/especial por compatibilidade com histórico e banco,
  // mas eles seguem sempre a comissão padrão para evitar simulações confusas.
  const maxAffiliateCommissionPercent = affiliateCommissionPercent;

  const specialAffiliateCommissionPercent = affiliateCommissionPercent;

  const minimumCompanyMarginPercent = normalizePercent(
    getAutoPercent(input.minimum_company_margin_percent, 15)
  );

  const commissionScenarioPercent = affiliateCommissionPercent;

  const networkCommissionPercent = normalizePercent(
    input.network_commission_percent ?? input.recruitment_commission_rate ?? input.networkCommissionPercent ?? 0
  );

  const manualGoalBonusResolution = resolveManualGoalBonusPerSale(input);
  const manualGoalBonusPerSale = roundMoney(manualGoalBonusResolution.value || 0);

  const goalLevelsBase = buildGoalLevelsAnalysis(goalLevels);
  const automaticGoalBonusPerSale = roundMoney(goalLevelsBase.worst_bonus_per_sale || 0);
  const goalBonusPerSale = manualGoalBonusPerSale > 0
    ? manualGoalBonusPerSale
    : automaticGoalBonusPerSale;

  const selectedGoalLevel = manualGoalBonusPerSale > 0
    ? {
        name: manualGoalBonusResolution.source === "manual_total_divided_by_goal"
          ? "Meta manual"
          : "Bônus manual por venda",
        level_order: null,
        accumulated_bonus_amount: manualGoalBonusResolution.total_bonus_amount || manualGoalBonusPerSale,
        required_conversions: manualGoalBonusResolution.required_conversions || 1,
        bonus_per_sale: manualGoalBonusPerSale,
      }
    : goalLevelsBase.worst_level || null;

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
    networkCommissionPercent,
    fixedAffiliateCost: goalBonusPerSale,
    marginPercent: safeMarginPercent,
  });

  const calculatedSuggestedPrice = calculatePriceForCommission({
    baseCost,
    gatewayFeePercent,
    taxPercent,
    commissionPercent: affiliateCommissionPercent,
    networkCommissionPercent,
    fixedAffiliateCost: goalBonusPerSale,
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
    networkCommissionPercent,
    fixedAffiliateCost: goalBonusPerSale,
    marginPercent: minimumCompanyMarginPercent,
  });

  const priceWithSpecialCommission = calculatePriceForCommission({
    baseCost,
    gatewayFeePercent,
    taxPercent,
    commissionPercent: specialAffiliateCommissionPercent,
    networkCommissionPercent,
    fixedAffiliateCost: goalBonusPerSale,
    marginPercent: minimumCompanyMarginPercent,
  });

  const defaultProfitData = calculateProfitForPrice({
    price: priceWithDefaultCommission,
    baseCost,
    gatewayFeePercent,
    taxPercent,
    commissionPercent: affiliateCommissionPercent,
    networkCommissionPercent,
    fixedAffiliateCost: goalBonusPerSale,
  });

  const maxProfitData = calculateProfitForPrice({
    price: priceWithMaxCommission,
    baseCost,
    gatewayFeePercent,
    taxPercent,
    commissionPercent: maxAffiliateCommissionPercent,
    networkCommissionPercent,
    fixedAffiliateCost: goalBonusPerSale,
  });

  const specialProfitData = calculateProfitForPrice({
    price: priceWithSpecialCommission,
    baseCost,
    gatewayFeePercent,
    taxPercent,
    commissionPercent: specialAffiliateCommissionPercent,
    networkCommissionPercent,
    fixedAffiliateCost: goalBonusPerSale,
  });

  const suggestedProfitData = calculateProfitForPrice({
    price: suggestedPrice,
    baseCost,
    gatewayFeePercent,
    taxPercent,
    commissionPercent: affiliateCommissionPercent,
    networkCommissionPercent,
    fixedAffiliateCost: goalBonusPerSale,
  });

  const currentProductPrice = roundMoney(product?.price || input.current_product_price || 0);
  const safeCommissionReferencePrice =
    currentProductPrice > 0 ? currentProductPrice : suggestedPrice;

  const safeCommissionAnalysis = calculateSafeDirectCommissionForPrice({
    price: safeCommissionReferencePrice,
    baseCost,
    gatewayFeePercent,
    taxPercent,
    networkCommissionPercent,
    fixedAffiliateCost: goalBonusPerSale,
    minimumCompanyMarginPercent,
  });

  const currentDirectCommissionValue = roundMoney(
    safeCommissionReferencePrice * (affiliateCommissionPercent / 100)
  );

  const safeCommissionGapValue = roundMoney(
    safeCommissionAnalysis.safe_commission_value - currentDirectCommissionValue
  );

  const safeCommissionStatus =
    affiliateCommissionPercent <= safeCommissionAnalysis.safe_commission_percent
      ? "healthy"
      : safeCommissionAnalysis.safe_commission_percent > 0
        ? "attention"
        : "danger";

  const safeCommissionMessage =
    safeCommissionStatus === "healthy"
      ? "A comissão atual está segura no preço atual do produto, mantendo a margem mínima da empresa."
      : safeCommissionAnalysis.safe_commission_percent > 0
        ? "A comissão padrão passa do limite seguro no preço atual. Use a comissão sugerida ou aumente o preço antes de manter essa comissão para todos os afiliados."
        : "O preço atual não suporta comissão direta mantendo custos, comissão de rede, bônus de meta e margem mínima. Revise custos, margem ou preço.";

  const goalAnalysis = buildGoalAnalysisForPricing({
    goalLevels,
    baseCost,
    gatewayFeePercent,
    taxPercent,
    affiliateCommissionPercent,
    maxAffiliateCommissionPercent,
    specialAffiliateCommissionPercent,
    networkCommissionPercent,
    minimumCompanyMarginPercent,
    suggestedPrice,
    currentProductPrice,
  });

  const goalRequiredPrices = Array.isArray(goalAnalysis?.levels)
    ? goalAnalysis.levels
        .map((level) => roundMoney(level?.required_price_default || 0))
        .filter((value) => value > 0)
    : [];

  const allGoalsSafePrice = roundMoney(
    Math.max(
      suggestedPrice || 0,
      priceWithDefaultCommission || 0,
      safePrice || 0,
      ...goalRequiredPrices
    )
  );

  const allGoalsSafeProfitData = calculateProfitForPrice({
    price: allGoalsSafePrice,
    baseCost,
    gatewayFeePercent,
    taxPercent,
    commissionPercent: affiliateCommissionPercent,
    networkCommissionPercent,
    fixedAffiliateCost: goalBonusPerSale,
  });

  const adjustedSuggestedPriceForGoalGap = manualSuggestedPrice > 0
    ? manualSuggestedPrice
    : 0;

  const allGoalsSafeReferencePrice = roundMoney(
    Math.max(currentProductPrice || 0, adjustedSuggestedPriceForGoalGap || 0)
  );

  const allGoalsSafeReferenceType =
    adjustedSuggestedPriceForGoalGap > (currentProductPrice || 0)
      ? "suggested_price"
      : "current_price";

  const allGoalsSafeGapValue = roundMoney(
    Math.max(allGoalsSafePrice - allGoalsSafeReferencePrice, 0)
  );

  const allGoalsSafeStatus = allGoalsSafeGapValue <= 0.02 ? "healthy" : "attention";
  const allGoalsSafeWasAdjusted = allGoalsSafeStatus === "healthy" && allGoalsSafeReferenceType === "suggested_price";

  const allGoalsSafeMessage = goalRequiredPrices.length
    ? allGoalsSafeStatus === "healthy"
      ? allGoalsSafeWasAdjusted
        ? "O preço sugerido ajustado já cobre todas as metas ativas, comissão padrão, comissão de rede e margem mínima."
        : "O preço atual já suporta todas as metas ativas, comissão padrão, comissão de rede e margem mínima."
      : "O preço atual ainda não suporta todas as metas ativas. Use o preço seguro sugerido para cobrir bônus de meta, comissão padrão, comissão de rede e margem mínima."
    : "Nenhuma meta ativa foi encontrada. O preço seguro considera comissão padrão, comissão de rede e margem mínima.";

  const allGoalsSafeDirectCommissionValue = roundMoney(
    allGoalsSafeProfitData.commission_value
  );
  const allGoalsSafeNetworkCommissionValue = roundMoney(
    allGoalsSafeProfitData.network_commission_value
  );
  const allGoalsSafeGoalBonusValue = roundMoney(
    allGoalsSafeProfitData.goal_bonus_value
  );
  const allGoalsSafeAffiliateTotalCost = roundMoney(
    allGoalsSafeProfitData.affiliate_total_cost
  );

  const decisionStatus = allGoalsSafeStatus === "healthy" ? "healthy" : "attention";
  const decisionTitle =
    decisionStatus === "healthy"
      ? allGoalsSafeWasAdjusted
        ? "Preço sugerido seguro para cobrir as metas"
        : "Produto seguro para vender com metas"
      : "Produto precisa de ajuste para cobrir as metas";
  const decisionMessage =
    decisionStatus === "healthy"
      ? allGoalsSafeWasAdjusted
        ? "O preço sugerido ajustado cobre custos, comissão padrão, comissão de rede, maior bônus médio das metas e margem mínima. Salve e aplique o preço no produto para finalizar."
        : "O preço atual cobre custos, comissão padrão, comissão de rede, maior bônus médio das metas e margem mínima."
      : `Ajuste o preço sugerido para ${formatCurrencyBRL(allGoalsSafePrice)} para cobrir todas as metas, pagar comissão ao afiliado e manter a margem mínima.`;

  const riskReasons = [];

  if (allGoalsSafeWasAdjusted) {
    riskReasons.push(
      `Preço sugerido ajustado para ${formatCurrencyBRL(allGoalsSafeReferencePrice)} já cobre todas as metas com segurança.`
    );
  } else if (allGoalsSafeReferencePrice > 0 && allGoalsSafeGapValue > 0) {
    riskReasons.push(
      `Preço em análise abaixo do seguro para metas em ${formatCurrencyBRL(allGoalsSafeGapValue)}.`
    );
  }

  if (goalBonusPerSale > 0) {
    riskReasons.push(
      `Maior bônus médio de meta considerado: ${formatCurrencyBRL(goalBonusPerSale)} por venda.`
    );
  }

  if (affiliateCommissionPercent > 0) {
    riskReasons.push(
      `Comissão padrão do afiliado vendedor: ${affiliateCommissionPercent.toFixed(2)}%.`
    );
  }

  if (networkCommissionPercent > 0) {
    riskReasons.push(
      `Comissão de rede/recrutamento ativa: ${networkCommissionPercent.toFixed(2)}%.`
    );
  }

  if (minimumCompanyMarginPercent > 0) {
    riskReasons.push(
      `Margem mínima protegida da empresa: ${minimumCompanyMarginPercent.toFixed(2)}%.`
    );
  }

  const risk = buildRiskStatus({
    suggestedPrice,
    priceWithMaxCommission,
    profitWithMaxCommission: maxProfitData.profit,
    marginWithMaxCommissionPercent: maxProfitData.margin_percent,
    minimumCompanyMarginPercent,
    maxAffiliateCommissionPercent,
    specialAffiliateCommissionPercent,
  });

  const directCommissionValue = roundMoney(suggestedProfitData.commission_value);
  const networkCommissionValue = roundMoney(suggestedProfitData.network_commission_value);
  const goalBonusValue = roundMoney(suggestedProfitData.goal_bonus_value);
  const affiliateTotalCost = roundMoney(suggestedProfitData.affiliate_total_cost);

  return {
    cost_price: roundMoney(costPrice),
    packaging_cost: roundMoney(packagingCost),
    traffic_cost: roundMoney(trafficCost),
    gateway_fee_percent: roundMoney(gatewayFeePercent),
    tax_percent: roundMoney(taxPercent),
    tax_percent_source: taxResolution.source,
    tax_automation: taxResolution.automation,
    other_costs: roundMoney(otherCosts),
    average_shipping_cost: roundMoney(averageShippingCost),
    shipping_policy: shippingPolicy,
    installment_interest_policy: normalizeInstallmentInterestPolicy(
      input.installment_interest_policy || input.payment_interest_policy
    ),
    desired_margin_percent: roundMoney(desiredMarginPercent),

    affiliate_commission_percent: roundMoney(affiliateCommissionPercent),
    max_affiliate_commission_percent: roundMoney(maxAffiliateCommissionPercent),
    special_affiliate_commission_percent: roundMoney(specialAffiliateCommissionPercent),
    minimum_company_margin_percent: roundMoney(minimumCompanyMarginPercent),
    commission_scenario_percent: roundMoney(commissionScenarioPercent),
    network_commission_percent: roundMoney(networkCommissionPercent),

    goal_pricing_mode: manualGoalBonusPerSale > 0
      ? manualGoalBonusResolution.source
      : goalLevels?.length
        ? "auto_worst_goal_per_sale"
        : "no_active_goal",
    goal_bonus_source: manualGoalBonusPerSale > 0
      ? manualGoalBonusResolution.source
      : goalLevels?.length
        ? "affiliate_levels"
        : "none",
    goal_bonus_warning: manualGoalBonusResolution.warning,
    goal_bonus_amount: roundMoney(selectedGoalLevel?.accumulated_bonus_amount || 0),
    goal_required_conversions: Math.trunc(toNumber(selectedGoalLevel?.required_conversions || 0, 0)),
    goal_bonus_per_sale: roundMoney(goalBonusPerSale),
    selected_goal_level_name: selectedGoalLevel?.name || null,
    selected_goal_level_order: selectedGoalLevel?.level_order || null,
    recommended_goal_level_name: goalAnalysis.recommended_level?.name || null,
    recommended_goal_level_order: goalAnalysis.recommended_level?.level_order || null,
    worst_goal_level_name: goalAnalysis.worst_level?.name || null,
    worst_goal_bonus_per_sale: roundMoney(goalAnalysis.worst_bonus_per_sale || 0),
    goal_analysis: goalAnalysis,
    all_goals_safe_price: roundMoney(allGoalsSafePrice),
    all_goals_safe_reference_price: roundMoney(allGoalsSafeReferencePrice),
    all_goals_safe_reference_type: allGoalsSafeReferenceType,
    all_goals_safe_was_adjusted: allGoalsSafeWasAdjusted,
    all_goals_safe_gap_value: roundMoney(allGoalsSafeGapValue),
    all_goals_safe_status: allGoalsSafeStatus,
    all_goals_safe_message: allGoalsSafeMessage,
    all_goals_safe_profit: roundMoney(allGoalsSafeProfitData.profit),
    all_goals_safe_margin_percent: roundMoney(allGoalsSafeProfitData.margin_percent),
    all_goals_safe_direct_commission_value: allGoalsSafeDirectCommissionValue,
    all_goals_safe_network_commission_value: allGoalsSafeNetworkCommissionValue,
    all_goals_safe_goal_bonus_value: allGoalsSafeGoalBonusValue,
    all_goals_safe_affiliate_total_cost: allGoalsSafeAffiliateTotalCost,
    pricing_decision_status: decisionStatus,
    pricing_decision_title: decisionTitle,
    pricing_decision_message: decisionMessage,
    pricing_risk_reasons: riskReasons,

    cost_total: roundMoney(baseCost),
    minimum_price: roundMoney(minimumPrice),
    safe_price: roundMoney(safePrice),
    suggested_price: roundMoney(suggestedPrice),
    unit_profit: roundMoney(suggestedProfitData.profit),
    real_margin_percent: roundMoney(suggestedProfitData.margin_percent),

    current_product_price: roundMoney(currentProductPrice),
    safe_commission_reference_price: roundMoney(safeCommissionReferencePrice),
    safe_affiliate_commission_percent: roundMoney(
      safeCommissionAnalysis.safe_commission_percent
    ),
    safe_affiliate_commission_value: roundMoney(
      safeCommissionAnalysis.safe_commission_value
    ),
    safe_commission_current_value: roundMoney(currentDirectCommissionValue),
    safe_commission_gap_value: roundMoney(safeCommissionGapValue),
    safe_commission_status: safeCommissionStatus,
    safe_commission_message: safeCommissionMessage,
    safe_commission_protected_cost_total: roundMoney(
      safeCommissionAnalysis.protected_cost_total
    ),
    safe_commission_available_before_direct: roundMoney(
      safeCommissionAnalysis.available_before_direct_commission
    ),
    minimum_company_profit_value: roundMoney(
      safeCommissionAnalysis.minimum_company_profit_value
    ),

    direct_commission_value: directCommissionValue,
    network_commission_value: networkCommissionValue,
    goal_bonus_value: goalBonusValue,
    affiliate_total_cost: affiliateTotalCost,
    affiliate_total_cost_default: roundMoney(defaultProfitData.affiliate_total_cost),
    affiliate_total_cost_max: roundMoney(maxProfitData.affiliate_total_cost),
    affiliate_total_cost_special: roundMoney(specialProfitData.affiliate_total_cost),

    price_with_default_commission: roundMoney(priceWithDefaultCommission),
    price_with_max_commission: roundMoney(priceWithMaxCommission),
    price_with_special_commission: roundMoney(priceWithSpecialCommission),

    profit_with_default_commission: roundMoney(defaultProfitData.profit),
    profit_with_max_commission: roundMoney(maxProfitData.profit),
    profit_with_special_commission: roundMoney(specialProfitData.profit),

    margin_with_default_commission_percent: roundMoney(defaultProfitData.margin_percent),
    margin_with_max_commission_percent: roundMoney(maxProfitData.margin_percent),
    margin_with_special_commission_percent: roundMoney(specialProfitData.margin_percent),

    status: risk.status,
    risk_message: risk.risk_message,
  };
}

function stripTransientPricingFields(pricing = {}) {
  const {
    tax_percent_source,
    tax_automation,
    installment_interest_policy,
    payment_interest_policy,
    current_product_price,
    safe_commission_reference_price,
    safe_affiliate_commission_percent,
    safe_affiliate_commission_value,
    safe_commission_current_value,
    safe_commission_gap_value,
    safe_commission_status,
    safe_commission_message,
    safe_commission_protected_cost_total,
    safe_commission_available_before_direct,
    minimum_company_profit_value,
    all_goals_safe_price,
    all_goals_safe_reference_price,
    all_goals_safe_reference_type,
    all_goals_safe_was_adjusted,
    all_goals_safe_gap_value,
    all_goals_safe_status,
    all_goals_safe_message,
    all_goals_safe_profit,
    all_goals_safe_margin_percent,
    all_goals_safe_direct_commission_value,
    all_goals_safe_network_commission_value,
    all_goals_safe_goal_bonus_value,
    all_goals_safe_affiliate_total_cost,
    pricing_decision_status,
    pricing_decision_title,
    pricing_decision_message,
    pricing_risk_reasons,
    ...persistablePricing
  } = pricing || {};

  return persistablePricing;
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
    network_commission_percent: roundMoney(pricingData.network_commission_percent),
    goal_pricing_mode: pricingData.goal_pricing_mode || null,
    goal_bonus_amount: roundMoney(pricingData.goal_bonus_amount),
    goal_required_conversions: Math.trunc(toNumber(pricingData.goal_required_conversions, 0)),
    goal_bonus_per_sale: roundMoney(pricingData.goal_bonus_per_sale),
    selected_goal_level_name: pricingData.selected_goal_level_name || null,
    selected_goal_level_order: pricingData.selected_goal_level_order || null,
    recommended_goal_level_name: pricingData.recommended_goal_level_name || null,
    recommended_goal_level_order: pricingData.recommended_goal_level_order || null,
    worst_goal_level_name: pricingData.worst_goal_level_name || null,
    worst_goal_bonus_per_sale: roundMoney(pricingData.worst_goal_bonus_per_sale),
    goal_analysis: pricingData.goal_analysis || null,

    cost_total: roundMoney(pricingData.cost_total),
    minimum_price: roundMoney(pricingData.minimum_price),
    safe_price: roundMoney(pricingData.safe_price),
    suggested_price: roundMoney(pricingData.suggested_price),
    unit_profit: roundMoney(pricingData.unit_profit),
    real_margin_percent: roundMoney(pricingData.real_margin_percent),
    direct_commission_value: roundMoney(pricingData.direct_commission_value),
    network_commission_value: roundMoney(pricingData.network_commission_value),
    goal_bonus_value: roundMoney(pricingData.goal_bonus_value),
    affiliate_total_cost: roundMoney(pricingData.affiliate_total_cost),
    affiliate_total_cost_default: roundMoney(pricingData.affiliate_total_cost_default),
    affiliate_total_cost_max: roundMoney(pricingData.affiliate_total_cost_max),
    affiliate_total_cost_special: roundMoney(pricingData.affiliate_total_cost_special),

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

    // Campos prontos para gravar no produto e exibir na loja.
    installment_count: rule.installments,
    installment_value: roundMoney(amount / Number(rule.installments || 1)),
    installment_label: `${rule.installments}x de ${formatCurrencyBRL(roundMoney(amount / Number(rule.installments || 1)))}`,
    payment_method_simulated: rule.payment_method,
    payment_fee_value: feeAmount,
    payment_net_value: netAmount,

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

async function listAffiliateLevelsForPricing() {
  try {
    const rows = await supabaseFetch(
      "affiliate_levels?select=*&order=level_order.asc",
      { method: "GET" }
    );

    return Array.isArray(rows) ? rows : [];
  } catch (error) {
    console.error("PRICING GOAL LEVELS LOAD ERROR:", error);
    return [];
  }
}

export async function calculateProductPricing(payload) {
  const productId = payload.product_id || payload.productId;

  if (!productId) {
    throw new Error("product_id é obrigatório.");
  }

  const payloadGoalLevels = Array.isArray(payload.affiliate_goal_levels)
    ? payload.affiliate_goal_levels
    : Array.isArray(payload.goal_levels)
      ? payload.goal_levels
      : [];

  const [databaseGoalLevels, product] = await Promise.all([
    payloadGoalLevels.length ? Promise.resolve([]) : listAffiliateLevelsForPricing(),
    getProductById(productId).catch(() => null),
  ]);

  // A aba de Metas e Bônus conversa com a Precificação de duas formas:
  // 1) pelo banco affiliate_levels, quando a API busca sozinha;
  // 2) pelo payload affiliate_goal_levels/goal_levels, quando o admin já carregou as metas.
  // O payload tem prioridade para refletir imediatamente o que está ativo no admin.
  const goalLevels = payloadGoalLevels.length ? payloadGoalLevels : databaseGoalLevels;

  const pricing = calculatePricing(payload, goalLevels, product);

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
  const persistableCalculated = stripTransientPricingFields(calculated);
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
        ...persistableCalculated,
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
        ...persistableCalculated,
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

function resolveInstallmentCount(pricing = {}) {
  const raw =
    pricing.installment_count ||
    pricing.installments ||
    pricing.payment_installments ||
    pricing.credit_card_installments ||
    12;

  try {
    return normalizeInstallments(raw);
  } catch {
    return 12;
  }
}

function buildProductPricingPatch(suggestedPrice, pricing = {}) {
  const installmentCount = resolveInstallmentCount(pricing);
  const interestPolicy = normalizeInstallmentInterestPolicy(
    pricing.installment_interest_policy || pricing.payment_interest_policy
  );

  if (interestPolicy === "customer_pays") {
    return {
      price: suggestedPrice,
      installment_count: installmentCount,
      installment_value: null,
      installment_label: "Parcelamento com juros no Mercado Pago",
      payment_method_simulated: "credit_card_customer_interest",
      payment_fee_value: null,
      payment_net_value: null,
      pricing_updated_at: new Date().toISOString(),
    };
  }

  const installmentValue = roundMoney(
    pricing.installment_value ||
      pricing.installmentValue ||
      (suggestedPrice > 0 ? suggestedPrice / installmentCount : 0)
  );
  const paymentFeeValue = roundMoney(
    pricing.payment_fee_value ||
      pricing.paymentFeeValue ||
      pricing.fee_amount ||
      pricing.payment_fee_amount ||
      0
  );
  const paymentNetValue = roundMoney(
    pricing.payment_net_value ||
      pricing.paymentNetValue ||
      pricing.net_amount ||
      (suggestedPrice > 0 && paymentFeeValue > 0 ? suggestedPrice - paymentFeeValue : 0)
  );

  return {
    price: suggestedPrice,
    installment_count: installmentCount,
    installment_value: installmentValue > 0 ? installmentValue : null,
    installment_label:
      installmentValue > 0
        ? `A partir de ${installmentCount}x de ${formatCurrencyBRL(installmentValue)}`
        : null,
    payment_method_simulated:
      pricing.payment_method_simulated ||
      pricing.payment_method ||
      pricing.paymentMethod ||
      "credit_card",
    payment_fee_value: paymentFeeValue > 0 ? paymentFeeValue : null,
    payment_net_value: paymentNetValue > 0 ? paymentNetValue : null,
    pricing_updated_at: new Date().toISOString(),
  };
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
    body: JSON.stringify(buildProductPricingPatch(suggestedPrice, {
      ...pricing,
      ...(payload || {}),
    })),
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
  const filters = [
    "select=id,name,sku,price,installment_count,installment_value,installment_label,payment_method_simulated,payment_fee_value,payment_net_value,pricing_updated_at"
  ];

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