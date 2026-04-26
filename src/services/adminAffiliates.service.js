import { env } from "../config/env.js";

const SUPABASE_URL = String(env.supabaseUrl || "").replace(/\/+$/, "");
const SERVICE_ROLE_KEY = env.supabaseServiceRoleKey;

function getHeaders(extra = {}) {
  return {
    apikey: SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    ...extra,
  };
}

function assertSupabaseConfig() {
  if (!SUPABASE_URL) {
    throw new Error("SUPABASE_URL não configurado.");
  }

  if (!SERVICE_ROLE_KEY) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY não configurado.");
  }
}

async function supabaseRequest(path, options = {}) {
  assertSupabaseConfig();

  const response = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    ...options,
    headers: getHeaders(options.headers || {}),
  });

  const text = await response.text();
  let data = null;

  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!response.ok) {
    const message =
      data?.message ||
      data?.error_description ||
      data?.hint ||
      data?.details ||
      `Erro Supabase: ${response.status}`;

    throw new Error(message);
  }

  return data;
}

function cleanText(value) {
  return String(value || "").trim();
}

function normalizeCode(value) {
  return cleanText(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, "");
}

function toNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function buildAffiliatePayload(input = {}, isUpdate = false) {
  const fullName = cleanText(input.full_name || input.fullName || input.name);
  const email = cleanText(input.email).toLowerCase();
  const phone = cleanText(input.phone || input.telefone);
  const refCode = normalizeCode(input.ref_code || input.refCode);
  const couponCode = normalizeCode(input.coupon_code || input.couponCode);
  const status = cleanText(input.status || "active") || "active";
  const commissionRate = toNumber(
    input.commission_rate ?? input.commissionRate,
    10
  );
  const pixKey = cleanText(input.pix_key || input.pixKey);
  const notes = cleanText(input.notes);

  const payload = {};

  if (!isUpdate || fullName) payload.full_name = fullName;
  if (!isUpdate || email) payload.email = email;
  if (!isUpdate || phone) payload.phone = phone || null;
  if (!isUpdate || refCode) payload.ref_code = refCode;
  if (!isUpdate || couponCode) payload.coupon_code = couponCode || null;
  if (!isUpdate || status) payload.status = status;
  if (!isUpdate || input.commission_rate !== undefined || input.commissionRate !== undefined) {
    payload.commission_rate = commissionRate;
  }
  if (!isUpdate || pixKey) payload.pix_key = pixKey || null;
  if (!isUpdate || notes) payload.notes = notes || null;

  if (!isUpdate) {
    if (!payload.full_name) throw new Error("Nome do afiliado é obrigatório.");
    if (!payload.email) throw new Error("E-mail do afiliado é obrigatório.");
    if (!payload.ref_code) throw new Error("Código de referência é obrigatório.");

    if (!payload.coupon_code) {
      payload.coupon_code = null;
    }

    if (!payload.status) {
      payload.status = "active";
    }

    if (payload.commission_rate === undefined || payload.commission_rate === null) {
      payload.commission_rate = 10;
    }
  }

  if (payload.status && !["active", "inactive", "blocked"].includes(payload.status)) {
    throw new Error("Status inválido. Use active, inactive ou blocked.");
  }

  if (
    payload.commission_rate !== undefined &&
    (payload.commission_rate < 0 || payload.commission_rate > 100)
  ) {
    throw new Error("A comissão precisa estar entre 0 e 100.");
  }

  return payload;
}

export async function listAffiliates(filters = {}) {
  const search = cleanText(filters.search);
  const status = cleanText(filters.status);

  const params = new URLSearchParams();
  params.set("select", "*");
  params.set("order", "created_at.desc");

  if (status) {
    params.set("status", `eq.${status}`);
  }

  if (search) {
    params.set(
      "or",
      `(full_name.ilike.*${search}*,email.ilike.*${search}*,ref_code.ilike.*${search}*,coupon_code.ilike.*${search}*)`
    );
  }

  return supabaseRequest(`/affiliates?${params.toString()}`);
}

export async function listAffiliateSummary(filters = {}) {
  const search = cleanText(filters.search);
  const status = cleanText(filters.status);

  const params = new URLSearchParams();
  params.set("select", "*");
  params.set("order", "created_at.desc");

  if (status) {
    params.set("status", `eq.${status}`);
  }

  if (search) {
    params.set(
      "or",
      `(full_name.ilike.*${search}*,email.ilike.*${search}*,ref_code.ilike.*${search}*,coupon_code.ilike.*${search}*)`
    );
  }

  return supabaseRequest(`/affiliate_summary?${params.toString()}`);
}

export async function getAffiliateById(id) {
  const affiliateId = cleanText(id);

  if (!affiliateId) {
    throw new Error("ID do afiliado é obrigatório.");
  }

  const params = new URLSearchParams();
  params.set("select", "*");
  params.set("id", `eq.${affiliateId}`);
  params.set("limit", "1");

  const rows = await supabaseRequest(`/affiliates?${params.toString()}`);
  return rows?.[0] || null;
}

export async function createAffiliate(input = {}) {
  const payload = buildAffiliatePayload(input, false);

  const created = await supabaseRequest("/affiliates", {
    method: "POST",
    headers: {
      Prefer: "return=representation",
    },
    body: JSON.stringify(payload),
  });

  return created?.[0] || null;
}

export async function updateAffiliate(id, input = {}) {
  const affiliateId = cleanText(id);

  if (!affiliateId) {
    throw new Error("ID do afiliado é obrigatório.");
  }

  const payload = buildAffiliatePayload(input, true);

  if (!Object.keys(payload).length) {
    throw new Error("Nenhum dado enviado para atualização.");
  }

  const updated = await supabaseRequest(`/affiliates?id=eq.${affiliateId}`, {
    method: "PATCH",
    headers: {
      Prefer: "return=representation",
    },
    body: JSON.stringify(payload),
  });

  return updated?.[0] || null;
}

export async function listAffiliateConversions(filters = {}) {
  const affiliateId = cleanText(filters.affiliate_id || filters.affiliateId);
  const status = cleanText(filters.status);

  const params = new URLSearchParams();
  params.set("select", "*");
  params.set("order", "created_at.desc");

  if (affiliateId) {
    params.set("affiliate_id", `eq.${affiliateId}`);
  }

  if (status) {
    params.set("status", `eq.${status}`);
  }

  return supabaseRequest(`/affiliate_conversions?${params.toString()}`);
}

export async function listAffiliatePayouts(filters = {}) {
  const affiliateId = cleanText(filters.affiliate_id || filters.affiliateId);
  const status = cleanText(filters.status);

  const params = new URLSearchParams();
  params.set("select", "*");
  params.set("order", "created_at.desc");

  if (affiliateId) {
    params.set("affiliate_id", `eq.${affiliateId}`);
  }

  if (status) {
    params.set("status", `eq.${status}`);
  }

  return supabaseRequest(`/affiliate_payouts?${params.toString()}`);
}