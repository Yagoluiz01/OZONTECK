const env = globalThis.env || {};

const SUPABASE_URL =
  env.supabaseUrl ||
  process.env.SUPABASE_URL ||
  process.env.NEXT_PUBLIC_SUPABASE_URL;

const SUPABASE_SERVICE_ROLE_KEY =
  env.supabaseServiceRoleKey ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY;

const DEFAULT_SETTINGS = {
  tax_regime: "simples_nacional",
  estimated_simples_percent: 4,
  estimated_inss_pf_percent: 11,
  estimated_irrf_enabled: true,
  estimated_iss_enabled: false,
  estimated_iss_pf_percent: 0,
};

function ensureSupabaseConfig() {
  if (!SUPABASE_URL) throw new Error("SUPABASE_URL não configurado.");
  if (!SUPABASE_SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY não configurado.");
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
  const cleanPath = String(path || "").replace(/^\/+/, "");
  return `${SUPABASE_URL}/rest/v1/${cleanPath}`;
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
      "FISCAL OPTIONAL FETCH:",
      error?.message || "Não foi possível buscar dados fiscais opcionais."
    );
    return fallback;
  }
}

function toNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function roundMoney(value) {
  return Number(toNumber(value, 0).toFixed(2));
}

function cleanText(value) {
  return String(value || "").trim();
}

function getMonthRange(competence = "") {
  const now = new Date();
  const match = String(competence || "").match(/^(\d{4})-(\d{2})$/);
  const year = match ? Number(match[1]) : now.getFullYear();
  const month = match ? Number(match[2]) - 1 : now.getMonth();

  const start = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, 0));
  const dueDate = new Date(Date.UTC(year, month + 1, 20, 0, 0, 0, 0));

  return {
    competence: `${year}-${String(month + 1).padStart(2, "0")}`,
    startIso: start.toISOString(),
    endIso: end.toISOString(),
    competenceMonth: start.toISOString().slice(0, 10),
    dueDate: dueDate.toISOString().slice(0, 10),
  };
}

function isPaidOrder(order = {}) {
  const fields = [
    order.payment_status,
    order.financial_status,
    order.status,
    order.payment_raw_status,
  ]
    .map((item) => String(item || "").toLowerCase())
    .filter(Boolean);

  return fields.some((value) =>
    ["paid", "approved", "completed", "pago", "aprovado"].includes(value)
  );
}

function isCanceledOrder(order = {}) {
  const fields = [order.payment_status, order.financial_status, order.status]
    .map((item) => String(item || "").toLowerCase())
    .filter(Boolean);

  return fields.some((value) =>
    ["cancelled", "canceled", "rejected", "refunded", "failed", "cancelado"].includes(
      value
    )
  );
}

function getOrderAmount(order = {}) {
  return roundMoney(
    toNumber(order.total_amount) ||
      toNumber(order.total) ||
      toNumber(order.amount) ||
      toNumber(order.gross_amount) ||
      toNumber(order.payment_amount) ||
      0
  );
}

function getShippingAmount(order = {}) {
  return roundMoney(
    toNumber(order.shipping_amount) ||
      toNumber(order.freight_amount) ||
      toNumber(order.shipping_price) ||
      toNumber(order.delivery_fee) ||
      0
  );
}

function getCommissionAmount(row = {}) {
  return roundMoney(
    toNumber(row.commission_amount) ||
      toNumber(row.amount) ||
      toNumber(row.commission_value) ||
      toNumber(row.network_commission) ||
      toNumber(row.recruitment_bonus_amount) ||
      0
  );
}

function getPayoutAmount(row = {}) {
  return roundMoney(toNumber(row.amount) || toNumber(row.total_amount) || 0);
}

function estimateIrrfMonthly(baseAmount = 0) {
  const base = roundMoney(baseAmount);

  // Tabela progressiva mensal vigente a partir de maio/2025.
  // Mantida como estimativa operacional para painel; contador deve validar o valor oficial.
  const ranges = [
    { limit: 2428.8, rate: 0, deduction: 0 },
    { limit: 2826.65, rate: 0.075, deduction: 182.16 },
    { limit: 3751.05, rate: 0.15, deduction: 394.16 },
    { limit: 4664.68, rate: 0.225, deduction: 675.49 },
    { limit: Infinity, rate: 0.275, deduction: 908.73 },
  ];

  const range = ranges.find((item) => base <= item.limit) || ranges[0];
  return roundMoney(Math.max(0, base * range.rate - range.deduction));
}

function normalizeSettings(row = null) {
  return {
    ...DEFAULT_SETTINGS,
    ...(row || {}),
    estimated_simples_percent: toNumber(
      row?.estimated_simples_percent,
      DEFAULT_SETTINGS.estimated_simples_percent
    ),
    estimated_inss_pf_percent: toNumber(
      row?.estimated_inss_pf_percent,
      DEFAULT_SETTINGS.estimated_inss_pf_percent
    ),
    estimated_iss_pf_percent: toNumber(row?.estimated_iss_pf_percent, 0),
    estimated_irrf_enabled: row?.estimated_irrf_enabled !== false,
    estimated_iss_enabled: row?.estimated_iss_enabled === true,
  };
}

export async function getFiscalSettings() {
  const rows = await optionalSupabaseFetch(
    "fiscal_settings?select=*&order=created_at.asc&limit=1",
    { method: "GET" },
    []
  );

  return normalizeSettings(rows?.[0] || null);
}

export async function updateFiscalSettings(payload = {}) {
  const current = await getFiscalSettings();
  const body = {
    company_name: payload.company_name ?? current.company_name ?? null,
    company_document: payload.company_document ?? current.company_document ?? null,
    tax_regime: payload.tax_regime ?? current.tax_regime ?? "simples_nacional",
    main_cnae: payload.main_cnae ?? current.main_cnae ?? null,
    secondary_cnaes: payload.secondary_cnaes ?? current.secondary_cnaes ?? [],
    estimated_simples_percent: roundMoney(
      payload.estimated_simples_percent ?? current.estimated_simples_percent ?? 4
    ),
    estimated_inss_pf_percent: roundMoney(
      payload.estimated_inss_pf_percent ?? current.estimated_inss_pf_percent ?? 11
    ),
    estimated_irrf_enabled:
      payload.estimated_irrf_enabled ?? current.estimated_irrf_enabled ?? true,
    estimated_iss_enabled:
      payload.estimated_iss_enabled ?? current.estimated_iss_enabled ?? false,
    estimated_iss_pf_percent: roundMoney(
      payload.estimated_iss_pf_percent ?? current.estimated_iss_pf_percent ?? 0
    ),
    notes: payload.notes ?? current.notes ?? null,
    updated_at: new Date().toISOString(),
  };

  if (current?.id) {
    const updated = await supabaseFetch(`fiscal_settings?id=eq.${current.id}`, {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(body),
    });

    return normalizeSettings(updated?.[0] || body);
  }

  const created = await supabaseFetch("fiscal_settings", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(body),
  });

  return normalizeSettings(created?.[0] || body);
}

async function listOrdersForCompetence(competence = "") {
  const { startIso, endIso } = getMonthRange(competence);

  return await optionalSupabaseFetch(
    `orders?select=*&created_at=gte.${encodeURIComponent(
      startIso
    )}&created_at=lt.${encodeURIComponent(endIso)}&order=created_at.desc`,
    { method: "GET" }
  );
}

async function listAffiliateConversionsForCompetence(competence = "") {
  const { startIso, endIso } = getMonthRange(competence);

  return await optionalSupabaseFetch(
    `affiliate_conversions?select=*&created_at=gte.${encodeURIComponent(
      startIso
    )}&created_at=lt.${encodeURIComponent(endIso)}&order=created_at.desc`,
    { method: "GET" }
  );
}

async function listAffiliatePayoutsForCompetence(competence = "") {
  const { startIso, endIso } = getMonthRange(competence);

  return await optionalSupabaseFetch(
    `affiliate_payouts?select=*&created_at=gte.${encodeURIComponent(
      startIso
    )}&created_at=lt.${encodeURIComponent(endIso)}&order=created_at.desc`,
    { method: "GET" }
  );
}

async function listAffiliatesByIds(ids = []) {
  const cleanIds = [...new Set(ids.map(cleanText).filter(Boolean))];

  if (!cleanIds.length) return [];

  return await optionalSupabaseFetch(
    `affiliates?select=*&id=in.(${cleanIds.map(encodeURIComponent).join(",")})`,
    { method: "GET" }
  );
}

function buildAffiliateTaxRecords({ conversions = [], payouts = [], affiliates = [], settings }) {
  const affiliateMap = (affiliates || []).reduce((acc, affiliate) => {
    acc[String(affiliate.id)] = affiliate;
    return acc;
  }, {});

  const grouped = new Map();

  function ensureRecord(affiliateId, fallback = {}) {
    const key = cleanText(affiliateId || fallback.affiliate_id || fallback.id || "sem-afiliado");

    if (!grouped.has(key)) {
      const affiliate = affiliateMap[key] || {};
      grouped.set(key, {
        affiliate_id: key === "sem-afiliado" ? null : key,
        affiliate_name:
          affiliate.full_name ||
          affiliate.name ||
          affiliate.affiliate_name ||
          fallback.affiliate_name ||
          fallback.full_name ||
          fallback.name ||
          "Afiliado não identificado",
        affiliate_document:
          affiliate.cpf ||
          affiliate.document ||
          affiliate.document_number ||
          fallback.affiliate_document ||
          fallback.cpf ||
          null,
        gross_commission_amount: 0,
        paid_amount: 0,
        pending_amount: 0,
        conversions_count: 0,
        payouts_count: 0,
        payment_status: "PENDENTE",
        source: "computed",
      });
    }

    return grouped.get(key);
  }

  for (const conversion of conversions || []) {
    const amount = getCommissionAmount(conversion);
    if (amount <= 0) continue;

    const record = ensureRecord(conversion.affiliate_id, conversion);
    record.gross_commission_amount = roundMoney(record.gross_commission_amount + amount);
    record.conversions_count += 1;
  }

  for (const payout of payouts || []) {
    const amount = getPayoutAmount(payout);
    if (amount <= 0) continue;

    const record = ensureRecord(payout.affiliate_id, payout);
    record.paid_amount = roundMoney(record.paid_amount + amount);
    record.payouts_count += 1;

    const status = String(payout.status || "").toLowerCase();
    if (["paid", "pago", "approved", "completed"].includes(status)) {
      record.payment_status = "PAGO";
    }
  }

  return [...grouped.values()].map((record) => {
    const gross = roundMoney(Math.max(record.gross_commission_amount, record.paid_amount));
    const inss = roundMoney((gross * toNumber(settings.estimated_inss_pf_percent, 11)) / 100);
    const irrf = settings.estimated_irrf_enabled ? estimateIrrfMonthly(Math.max(0, gross - inss)) : 0;
    const iss = settings.estimated_iss_enabled
      ? roundMoney((gross * toNumber(settings.estimated_iss_pf_percent, 0)) / 100)
      : 0;
    const net = roundMoney(Math.max(0, gross - inss - irrf - iss));

    return {
      ...record,
      gross_commission_amount: gross,
      estimated_inss_amount: inss,
      estimated_irrf_amount: irrf,
      estimated_iss_amount: iss,
      net_amount: net,
      pending_amount: roundMoney(Math.max(0, gross - record.paid_amount)),
    };
  });
}

export async function getFiscalSummary(competence = "") {
  const range = getMonthRange(competence);
  const settings = await getFiscalSettings();

  const [orders, conversions, payouts, obligations] = await Promise.all([
    listOrdersForCompetence(range.competence),
    listAffiliateConversionsForCompetence(range.competence),
    listAffiliatePayoutsForCompetence(range.competence),
    listFiscalObligations(range.competence),
  ]);

  const paidOrders = (orders || []).filter(isPaidOrder);
  const canceledOrders = (orders || []).filter(isCanceledOrder);
  const grossRevenue = roundMoney(paidOrders.reduce((sum, order) => sum + getOrderAmount(order), 0));
  const canceledRevenue = roundMoney(canceledOrders.reduce((sum, order) => sum + getOrderAmount(order), 0));
  const estimatedSimples = roundMoney((grossRevenue * settings.estimated_simples_percent) / 100);

  const affiliateIds = [
    ...(conversions || []).map((item) => item.affiliate_id),
    ...(payouts || []).map((item) => item.affiliate_id),
  ];
  const affiliates = await listAffiliatesByIds(affiliateIds);
  const affiliateTaxRecords = buildAffiliateTaxRecords({ conversions, payouts, affiliates, settings });

  const affiliateGross = roundMoney(
    affiliateTaxRecords.reduce((sum, item) => sum + toNumber(item.gross_commission_amount), 0)
  );
  const affiliatePaid = roundMoney(
    affiliateTaxRecords.reduce((sum, item) => sum + toNumber(item.paid_amount), 0)
  );
  const estimatedInss = roundMoney(
    affiliateTaxRecords.reduce((sum, item) => sum + toNumber(item.estimated_inss_amount), 0)
  );
  const estimatedIrrf = roundMoney(
    affiliateTaxRecords.reduce((sum, item) => sum + toNumber(item.estimated_irrf_amount), 0)
  );
  const estimatedIss = roundMoney(
    affiliateTaxRecords.reduce((sum, item) => sum + toNumber(item.estimated_iss_amount), 0)
  );
  const totalAffiliateRetentions = roundMoney(estimatedInss + estimatedIrrf + estimatedIss);

  const paidFiscal = roundMoney(
    (obligations || [])
      .filter((item) => String(item.status || "").toUpperCase() === "PAGO")
      .reduce((sum, item) => sum + toNumber(item.final_amount || item.estimated_amount), 0)
  );

  const manualPending = roundMoney(
    (obligations || [])
      .filter((item) => String(item.status || "").toUpperCase() !== "PAGO")
      .reduce((sum, item) => sum + toNumber(item.final_amount || item.estimated_amount), 0)
  );

  const estimatedTotalDue = roundMoney(estimatedSimples + totalAffiliateRetentions);

  return {
    competence: range.competence,
    period: {
      start: range.startIso,
      end: range.endIso,
      dueDate: range.dueDate,
    },
    settings,
    cards: {
      grossRevenue,
      paidOrdersCount: paidOrders.length,
      canceledOrdersCount: canceledOrders.length,
      canceledRevenue,
      taxBase: grossRevenue,
      estimatedSimples,
      affiliateGross,
      affiliatePaid,
      estimatedInss,
      estimatedIrrf,
      estimatedIss,
      totalAffiliateRetentions,
      estimatedTotalDue,
      manualPending,
      paidFiscal,
      fiscalPending: roundMoney(Math.max(0, estimatedTotalDue + manualPending - paidFiscal)),
    },
    notes: [
      "Valores fiscais são estimativas para controle interno.",
      "A apuração oficial deve ser validada pelo contador responsável.",
      "Pagamentos a afiliados pessoa física podem exigir INSS, IRRF e ISS conforme valor, município e enquadramento.",
    ],
  };
}

export async function listFiscalObligations(competence = "") {
  const range = getMonthRange(competence);
  const rows = await optionalSupabaseFetch(
    `fiscal_obligations?select=*&competence_month=eq.${range.competenceMonth}&order=due_date.asc.nullslast`,
    { method: "GET" }
  );

  return rows || [];
}

export async function createFiscalObligation(payload = {}) {
  const range = getMonthRange(payload.competence || payload.competence_month || "");
  const body = {
    obligation_type: cleanText(payload.obligation_type || payload.type || "OUTRO"),
    competence_month: payload.competence_month || range.competenceMonth,
    description: cleanText(payload.description || ""),
    estimated_amount: roundMoney(payload.estimated_amount),
    final_amount:
      payload.final_amount === undefined || payload.final_amount === ""
        ? null
        : roundMoney(payload.final_amount),
    due_date: payload.due_date || range.dueDate,
    paid_at: payload.paid_at || null,
    status: cleanText(payload.status || "PENDENTE").toUpperCase(),
    receipt_url: payload.receipt_url || null,
    notes: payload.notes || null,
    metadata: payload.metadata || {},
  };

  if (!body.description) throw new Error("Descrição da obrigação é obrigatória.");
  if (!body.obligation_type) throw new Error("Tipo da obrigação é obrigatório.");

  const result = await supabaseFetch("fiscal_obligations", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(body),
  });

  return result?.[0] || null;
}

export async function updateFiscalObligation(id, payload = {}) {
  const updates = { updated_at: new Date().toISOString() };

  if (payload.obligation_type !== undefined) updates.obligation_type = cleanText(payload.obligation_type);
  if (payload.competence_month !== undefined) updates.competence_month = payload.competence_month || null;
  if (payload.description !== undefined) updates.description = cleanText(payload.description);
  if (payload.estimated_amount !== undefined) updates.estimated_amount = roundMoney(payload.estimated_amount);
  if (payload.final_amount !== undefined) {
    updates.final_amount = payload.final_amount === "" || payload.final_amount === null ? null : roundMoney(payload.final_amount);
  }
  if (payload.due_date !== undefined) updates.due_date = payload.due_date || null;
  if (payload.paid_at !== undefined) updates.paid_at = payload.paid_at || null;
  if (payload.status !== undefined) updates.status = cleanText(payload.status).toUpperCase();
  if (payload.receipt_url !== undefined) updates.receipt_url = payload.receipt_url || null;
  if (payload.notes !== undefined) updates.notes = payload.notes || null;
  if (payload.metadata !== undefined) updates.metadata = payload.metadata || {};

  if (updates.status === "PAGO" && !updates.paid_at && payload.paid_at === undefined) {
    updates.paid_at = new Date().toISOString();
  }

  const result = await supabaseFetch(`fiscal_obligations?id=eq.${id}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(updates),
  });

  return result?.[0] || null;
}

export async function listAffiliateFiscalRecords(competence = "") {
  const range = getMonthRange(competence);
  const settings = await getFiscalSettings();

  const stored = await optionalSupabaseFetch(
    `affiliate_tax_records?select=*&competence_month=eq.${range.competenceMonth}&order=affiliate_name.asc`,
    { method: "GET" }
  );

  if (stored?.length) return stored;

  const [conversions, payouts] = await Promise.all([
    listAffiliateConversionsForCompetence(range.competence),
    listAffiliatePayoutsForCompetence(range.competence),
  ]);

  const affiliateIds = [
    ...(conversions || []).map((item) => item.affiliate_id),
    ...(payouts || []).map((item) => item.affiliate_id),
  ];
  const affiliates = await listAffiliatesByIds(affiliateIds);

  return buildAffiliateTaxRecords({ conversions, payouts, affiliates, settings });
}

export async function listInvoiceRecords(competence = "") {
  const range = getMonthRange(competence);
  const stored = await optionalSupabaseFetch(
    `order_invoice_records?select=*&created_at=gte.${encodeURIComponent(
      range.startIso
    )}&created_at=lt.${encodeURIComponent(range.endIso)}&order=created_at.desc`,
    { method: "GET" }
  );

  const orders = await listOrdersForCompetence(range.competence);
  const storedByOrder = (stored || []).reduce((acc, item) => {
    const key = item.order_id || item.order_number;
    if (key) acc[String(key)] = item;
    return acc;
  }, {});

  const derived = (orders || [])
    .filter(isPaidOrder)
    .map((order) => {
      const key = order.id || order.order_number;
      const storedRecord = storedByOrder[String(key)] || storedByOrder[String(order.order_number)] || null;
      return {
        id: storedRecord?.id || null,
        order_id: order.id,
        order_number: order.order_number || order.external_reference || order.id,
        customer_name:
          order.customer_name || order.customer_full_name || order.customer?.name || "Cliente não identificado",
        customer_document:
          order.customer_document || order.customer_cpf || order.customer?.document || null,
        invoice_status: storedRecord?.invoice_status || "NAO_EMITIDA",
        invoice_number: storedRecord?.invoice_number || null,
        invoice_key: storedRecord?.invoice_key || null,
        invoice_url: storedRecord?.invoice_url || null,
        issued_at: storedRecord?.issued_at || null,
        total_amount: getOrderAmount(order),
        shipping_amount: getShippingAmount(order),
        created_at: order.created_at,
        source: storedRecord ? "stored" : "order",
      };
    });

  return derived;
}

export default {
  getFiscalSummary,
  listFiscalObligations,
  createFiscalObligation,
  updateFiscalObligation,
  listAffiliateFiscalRecords,
  listInvoiceRecords,
  getFiscalSettings,
  updateFiscalSettings,
};
