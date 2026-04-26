import { env } from "../config/env.js";

const SUPABASE_URL = String(env.supabaseUrl || "").replace(/\/+$/, "");
const SERVICE_ROLE_KEY = env.supabaseServiceRoleKey;
const AFFILIATE_RECEIPTS_BUCKET = "affiliate-receipts";

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

async function supabaseStorageUpload({ bucket, path, buffer, mimeType }) {
  assertSupabaseConfig();

  const uploadUrl = `${SUPABASE_URL}/storage/v1/object/${bucket}/${path}`;

  const response = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": mimeType || "application/octet-stream",
      "x-upsert": "false",
    },
    body: buffer,
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
      data?.error ||
      data?.details ||
      `Erro ao enviar comprovante para o Storage: ${response.status}`;

    throw new Error(message);
  }

  return {
    path,
    publicUrl: `${SUPABASE_URL}/storage/v1/object/public/${bucket}/${path}`,
    raw: data,
  };
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

function toMoneyNumber(value, fallback = 0) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : fallback;
  }

  const cleanValue = String(value || "")
    .trim()
    .replace(/\s/g, "")
    .replace(/\./g, "")
    .replace(",", ".");

  const number = Number(cleanValue);
  return Number.isFinite(number) ? number : fallback;
}

function sanitizeFileName(value) {
  return cleanText(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

function getFileExtension(file = {}) {
  const originalName = sanitizeFileName(file.originalname || "");
  const byName = originalName.includes(".")
    ? originalName.split(".").pop()
    : "";

  if (byName) return byName;

  const mime = cleanText(file.mimetype).toLowerCase();

  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/png") return "png";
  if (mime === "image/webp") return "webp";
  if (mime === "application/pdf") return "pdf";

  return "bin";
}

function assertValidReceiptFile(file) {
  if (!file) return;

  const allowedMimeTypes = [
    "image/jpeg",
    "image/png",
    "image/webp",
    "application/pdf",
  ];

  if (!allowedMimeTypes.includes(file.mimetype)) {
    throw new Error(
      "Comprovante inválido. Envie imagem JPG, PNG, WEBP ou PDF."
    );
  }

  if (!file.buffer || !file.buffer.length) {
    throw new Error("Arquivo do comprovante está vazio.");
  }
}

async function uploadAffiliateReceipt(file, affiliateId) {
  if (!file) return null;

  assertValidReceiptFile(file);

  const extension = getFileExtension(file);
  const safeOriginalName = sanitizeFileName(
    file.originalname || `comprovante.${extension}`
  );
  const timestamp = Date.now();
  const random = Math.random().toString(36).slice(2, 10);

  const path = `${affiliateId}/${timestamp}-${random}-${safeOriginalName}`;

  const uploaded = await supabaseStorageUpload({
    bucket: AFFILIATE_RECEIPTS_BUCKET,
    path,
    buffer: file.buffer,
    mimeType: file.mimetype,
  });

  return {
    receipt_url: uploaded.publicUrl,
    receipt_path: path,
    receipt_file_name: file.originalname || safeOriginalName,
    receipt_mime_type: file.mimetype || null,
    receipt_uploaded_at: new Date().toISOString(),
  };
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

  if (
    !isUpdate ||
    input.commission_rate !== undefined ||
    input.commissionRate !== undefined
  ) {
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

    if (
      payload.commission_rate === undefined ||
      payload.commission_rate === null
    ) {
      payload.commission_rate = 10;
    }
  }

  if (
    payload.status &&
    !["active", "inactive", "blocked"].includes(payload.status)
  ) {
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

export async function createAffiliatePayout(input = {}) {
  const affiliateId = cleanText(input.affiliate_id || input.affiliateId);
  const amount = toMoneyNumber(input.amount, 0);
  const paymentMethod = cleanText(
    input.payment_method || input.paymentMethod || "pix"
  );
  const reference = cleanText(
    input.reference || input.payment_reference || input.paymentReference
  );
  const notes = cleanText(input.notes);
  const pixKey = cleanText(input.pix_key || input.pixKey);
  const receiptFile = input.receiptFile || null;

  if (!affiliateId) {
    throw new Error("ID do afiliado é obrigatório.");
  }

  if (amount <= 0) {
    throw new Error("O valor do pagamento precisa ser maior que zero.");
  }

  const affiliate = await getAffiliateById(affiliateId);

  if (!affiliate) {
    throw new Error("Afiliado não encontrado.");
  }

  const receiptData = receiptFile
    ? await uploadAffiliateReceipt(receiptFile, affiliateId)
    : null;

  const payload = {
    affiliate_id: affiliateId,
    amount,
    status: "paid",
    payment_method: paymentMethod || "pix",
    payment_reference: reference || null,
    pix_key: pixKey || affiliate.pix_key || null,
    notes: notes || null,
    paid_at: new Date().toISOString(),
    ...(receiptData || {}),
  };

  const created = await supabaseRequest("/affiliate_payouts", {
    method: "POST",
    headers: {
      Prefer: "return=representation",
    },
    body: JSON.stringify(payload),
  });

  return created?.[0] || null;
}

export async function listAffiliateApplications(filters = {}) {
  const status = cleanText(filters.status || "pending");
  const search = cleanText(filters.search);

  const params = new URLSearchParams();
  params.set("select", "*");
  params.set("order", "created_at.desc");

  if (status) {
    params.set("status", `eq.${status}`);
  }

  if (search) {
    params.set(
      "or",
      `(full_name.ilike.*${search}*,email.ilike.*${search}*,phone.ilike.*${search}*,desired_ref_code.ilike.*${search}*,desired_coupon_code.ilike.*${search}*)`
    );
  }

  return supabaseRequest(`/affiliate_applications?${params.toString()}`);
}

export async function getAffiliateApplicationById(id) {
  const applicationId = cleanText(id);

  if (!applicationId) {
    throw new Error("ID da solicitação é obrigatório.");
  }

  const params = new URLSearchParams();
  params.set("select", "*");
  params.set("id", `eq.${applicationId}`);
  params.set("limit", "1");

  const rows = await supabaseRequest(
    `/affiliate_applications?${params.toString()}`
  );

  return rows?.[0] || null;
}

export async function approveAffiliateApplication(id, input = {}) {
  const application = await getAffiliateApplicationById(id);

  if (!application) {
    throw new Error("Solicitação de afiliado não encontrada.");
  }

  if (application.status !== "pending") {
    throw new Error("Esta solicitação já foi analisada.");
  }

  const refCode = normalizeCode(
    input.ref_code ||
      input.refCode ||
      application.desired_ref_code ||
      application.full_name
  );

  const couponCode = normalizeCode(
    input.coupon_code ||
      input.couponCode ||
      application.desired_coupon_code ||
      `${refCode}10`
  );

  const commissionRate = toNumber(
    input.commission_rate ?? input.commissionRate,
    10
  );

  const affiliatePayload = {
    full_name: application.full_name,
    email: application.email,
    phone: application.phone || null,
    pix_key: application.pix_key || null,
    ref_code: refCode,
    coupon_code: couponCode || null,
    commission_rate: commissionRate,
    status: "active",
    notes: cleanText(
      input.notes || `Afiliado aprovado a partir da solicitação ${application.id}.`
    ),
  };

  const affiliate = await createAffiliate(affiliatePayload);

  if (!affiliate?.id) {
    throw new Error("Não foi possível criar o afiliado aprovado.");
  }

  const updatedApplications = await supabaseRequest(
    `/affiliate_applications?id=eq.${application.id}`,
    {
      method: "PATCH",
      headers: {
        Prefer: "return=representation",
      },
      body: JSON.stringify({
        status: "approved",
        affiliate_id: affiliate.id,
        approved_at: new Date().toISOString(),
        rejected_at: null,
        admin_notes:
          cleanText(input.admin_notes || input.adminNotes) || null,
        updated_at: new Date().toISOString(),
      }),
    }
  );

  return {
    application: updatedApplications?.[0] || null,
    affiliate,
  };
}

export async function rejectAffiliateApplication(id, input = {}) {
  const application = await getAffiliateApplicationById(id);

  if (!application) {
    throw new Error("Solicitação de afiliado não encontrada.");
  }

  if (application.status !== "pending") {
    throw new Error("Esta solicitação já foi analisada.");
  }

  const updatedApplications = await supabaseRequest(
    `/affiliate_applications?id=eq.${application.id}`,
    {
      method: "PATCH",
      headers: {
        Prefer: "return=representation",
      },
      body: JSON.stringify({
        status: "rejected",
        rejected_at: new Date().toISOString(),
        approved_at: null,
        affiliate_id: null,
        admin_notes:
          cleanText(input.admin_notes || input.adminNotes || input.reason) ||
          null,
        updated_at: new Date().toISOString(),
      }),
    }
  );

  return updatedApplications?.[0] || null;
}