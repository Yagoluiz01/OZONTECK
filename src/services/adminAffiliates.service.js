import { env } from "../config/env.js";
import { sendPushToAffiliate } from "./affiliatePush.service.js";

import {
  notifyAffiliateCreated,
  notifyAffiliateApproved,
  notifyAffiliateRejected,
  notifyAffiliatePayoutPaid,
} from "./affiliateNotification.service.js";

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

async function safeAffiliateNotification(label, callback) {
  try {
    return await callback();
  } catch (error) {
    console.error(`ERRO AO ENVIAR NOTIFICAÇÃO DE AFILIADO (${label}):`, error);
    return {
      sent: false,
      skipped: false,
      error: error?.message || "Erro ao enviar notificação de afiliado",
    };
  }
}


async function safeAffiliatePush(label, affiliateId, notification) {
  try {
    if (!affiliateId) {
      return {
        sent: 0,
        failed: 0,
        skipped: true,
        reason: "missing_affiliate_id",
      };
    }

    return await sendPushToAffiliate(affiliateId, notification);
  } catch (error) {
    console.error(`ERRO AO ENVIAR PUSH DE AFILIADO (${label}):`, error);
    return {
      sent: 0,
      failed: 1,
      skipped: false,
      error: error?.message || "Erro ao enviar push de afiliado",
    };
  }
}

function formatMoneyBR(value) {
  const number = Number(value || 0);

  return number.toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
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

  const raw = String(value || "").trim();

  if (!raw) {
    return fallback;
  }

  const normalized = raw.replace(/\s/g, "");

  const hasComma = normalized.includes(",");
  const hasDot = normalized.includes(".");

  let parsedValue = normalized;

  if (hasComma && hasDot) {
    parsedValue = normalized.replace(/\./g, "").replace(",", ".");
  } else if (hasComma) {
    parsedValue = normalized.replace(",", ".");
  }

  const number = Number(parsedValue);

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

const recruitmentCommissionRate = toNumber(
  input.recruitment_commission_rate ?? input.recruitmentCommissionRate,
  5
);

const pixKey = cleanText(input.pix_key || input.pixKey);
  const notes = cleanText(input.notes);
  const passwordHash = cleanText(input.password_hash || input.passwordHash);
  const accessEnabled =
    input.access_enabled !== undefined
      ? Boolean(input.access_enabled)
      : input.accessEnabled !== undefined
        ? Boolean(input.accessEnabled)
        : undefined;

        const recruiterAffiliateId = cleanText(
  input.recruiter_affiliate_id || input.recruiterAffiliateId
);

const recruiterRefCode = normalizeCode(
  input.recruiter_ref_code || input.recruiterRefCode
);

  const payload = {};

  if (!isUpdate || fullName) payload.full_name = fullName;
  if (!isUpdate || email) payload.email = email;
  if (!isUpdate || phone) payload.phone = phone || null;
  if (!isUpdate || refCode) payload.ref_code = refCode;
  if (!isUpdate || couponCode) payload.coupon_code = couponCode || null;
  if (!isUpdate || status) payload.status = status;

  if (!isUpdate || passwordHash) {
    if (passwordHash) payload.password_hash = passwordHash;
  }

  if (accessEnabled !== undefined) {
    payload.access_enabled = accessEnabled;
  }

  if (
    !isUpdate ||
    input.commission_rate !== undefined ||
    input.commissionRate !== undefined
  ) {
    payload.commission_rate = commissionRate;
  }

  if (
    !isUpdate ||
    input.recruitment_commission_rate !== undefined ||
    input.recruitmentCommissionRate !== undefined
  ) {
    payload.recruitment_commission_rate = recruitmentCommissionRate;
  }


  if (!isUpdate || pixKey) payload.pix_key = pixKey || null;
  if (!isUpdate || notes) payload.notes = notes || null;

  if (
  !isUpdate ||
  input.recruiter_affiliate_id !== undefined ||
  input.recruiterAffiliateId !== undefined
) {
  payload.recruiter_affiliate_id = recruiterAffiliateId || null;
}

if (
  !isUpdate ||
  input.recruiter_ref_code !== undefined ||
  input.recruiterRefCode !== undefined
) {
  payload.recruiter_ref_code = recruiterRefCode || null;
}

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


  if (
  payload.recruitment_commission_rate !== undefined &&
  (
    payload.recruitment_commission_rate < 0 ||
    payload.recruitment_commission_rate > 100
  )
) {
  throw new Error("A comissão de recrutamento precisa estar entre 0 e 100.");
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

  const affiliate = created?.[0] || null;

  if (affiliate && !input.skipAffiliateCreatedNotification) {
    await safeAffiliateNotification("affiliate_created", () =>
      notifyAffiliateCreated(affiliate)
    );
  }

  return affiliate;
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

  const payout = created?.[0] || null;

  if (payout) {
    await safeAffiliateNotification("affiliate_payout_paid", () =>
      notifyAffiliatePayoutPaid(affiliate, payout, receiptFile)
    );

    await safeAffiliatePush("affiliate_payout_paid", affiliateId, {
      title: "💰 Pago",
      body: `Pagamento de ${formatMoneyBR(amount)} registrado pela OZONTECK.`,
      url: "/pages-html/afiliado-painel.html",
      data: {
        type: "affiliate_payout_paid",
        affiliate_id: affiliateId,
        payout_id: payout.id || null,
        amount,
      },
    });
  }

  return payout;
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

  const recruitmentCommissionRate = toNumber(
  input.recruitment_commission_rate ?? input.recruitmentCommissionRate,
  5
);

  const recruiterAffiliateId = cleanText(
    input.recruiter_affiliate_id ||
      input.recruiterAffiliateId ||
      application.recruiter_affiliate_id
  );

  const recruiterRefCode = normalizeCode(
    input.recruiter_ref_code ||
      input.recruiterRefCode ||
      application.recruiter_ref_code
  );

  const affiliatePayload = {
    full_name: application.full_name,
    email: application.email,
    phone: application.phone || null,
    pix_key: application.pix_key || null,
    password_hash: application.password_hash || null,
    access_enabled: true,
    ref_code: refCode,
    coupon_code: couponCode || null,
    commission_rate: commissionRate,
    recruitment_commission_rate: recruitmentCommissionRate,
    recruiter_affiliate_id: recruiterAffiliateId || null,
    recruiter_ref_code: recruiterRefCode || null,
    status: "active",
    notes: cleanText(
      input.notes ||
        `Afiliado aprovado a partir da solicitação ${application.id}.`
    ),
  };

  const affiliate = await createAffiliate({
    ...affiliatePayload,
    skipAffiliateCreatedNotification: true,
  });

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

  setTimeout(() => {
    safeAffiliateNotification("affiliate_approved", () =>
      notifyAffiliateApproved(affiliate)
    ).catch((error) => {
      console.error(
        "ERRO AO ENVIAR NOTIFICAÇÃO DE APROVAÇÃO EM SEGUNDO PLANO:",
        error
      );
    });
  }, 0);

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

  const rejectedApplication = updatedApplications?.[0] || null;

  if (rejectedApplication) {
    await safeAffiliateNotification("affiliate_rejected", () =>
      notifyAffiliateRejected(rejectedApplication)
    );
  }

  return rejectedApplication;
}

export async function updateAffiliateCommissionBulk(input = {}) {
  const commissionRate = toNumber(
    input.commission_rate ?? input.commissionRate,
    NaN
  );
  const status = cleanText(input.status);

  if (!Number.isFinite(commissionRate)) {
    throw new Error("Informe uma porcentagem de comissão válida.");
  }

  if (commissionRate < 0 || commissionRate > 100) {
    throw new Error("A comissão precisa estar entre 0 e 100.");
  }

  if (status && !["active", "inactive", "blocked"].includes(status)) {
    throw new Error("Status inválido para atualização em massa.");
  }

  const params = new URLSearchParams();

  if (status) {
    params.set("status", `eq.${status}`);
  }

  const query = params.toString();
  const path = query ? `/affiliates?${query}` : "/affiliates";

  const updatedRows = await supabaseRequest(path, {
    method: "PATCH",
    headers: {
      Prefer: "return=representation",
    },
    body: JSON.stringify({
      commission_rate: Number(commissionRate.toFixed(2)),
    }),
  });

  const updated = Array.isArray(updatedRows) ? updatedRows.length : 0;
  const scopeLabel = status
    ? status === "active"
      ? "afiliados ativos"
      : status === "inactive"
        ? "afiliados inativos"
        : "afiliados bloqueados"
    : "todos os afiliados";

  return {
    updated,
    commission_rate: Number(commissionRate.toFixed(2)),
    status: status || "all",
    message: `Comissão de ${Number(commissionRate).toFixed(2)}% aplicada para ${updated} ${scopeLabel}.`,
  };
}

export async function listAffiliateNetwork(filters = {}) {
  const recruiterAffiliateId = cleanText(filters.recruiter_affiliate_id || filters.recruiterAffiliateId);
  const recruiterRefCode = normalizeCode(filters.recruiter_ref_code || filters.recruiterRefCode);

  const params = new URLSearchParams();
  params.set("select", "*");
  params.set("order", "recruited_created_at.desc");

  if (recruiterAffiliateId) {
    params.set("recruiter_affiliate_id", `eq.${recruiterAffiliateId}`);
  }

  if (recruiterRefCode) {
    params.set("recruiter_ref_code", `eq.${recruiterRefCode}`);
  }

  const rows = await supabaseRequest(`/affiliate_network_view?${params.toString()}`);
  return Array.isArray(rows) ? rows : [];
}

export async function listAffiliateNetworkApplications(filters = {}) {
  const recruiterAffiliateId = cleanText(filters.recruiter_affiliate_id || filters.recruiterAffiliateId);
  const recruiterRefCode = normalizeCode(filters.recruiter_ref_code || filters.recruiterRefCode);
  const status = cleanText(filters.status);

  const params = new URLSearchParams();
  params.set("select", "*");
  params.set("order", "created_at.desc");

  if (recruiterAffiliateId) {
    params.set("recruiter_affiliate_id", `eq.${recruiterAffiliateId}`);
  }

  if (recruiterRefCode) {
    params.set("recruiter_ref_code", `eq.${recruiterRefCode}`);
  }

  if (status) {
    params.set("status", `eq.${status}`);
  }

  const rows = await supabaseRequest(`/affiliate_network_applications_view?${params.toString()}`);
  return Array.isArray(rows) ? rows : [];
}

export async function getAffiliateNetwork(affiliateId) {
  const affiliate = await getAffiliateById(affiliateId);

  if (!affiliate?.id) {
    throw new Error("Afiliado não encontrado para consultar rede.");
  }

  const [recruited, applications] = await Promise.all([
    listAffiliateNetwork({ recruiter_affiliate_id: affiliate.id }),
    listAffiliateNetworkApplications({ recruiter_affiliate_id: affiliate.id }),
  ]);

  const approvedApplications = applications.filter((item) =>
    String(item.status || "").toLowerCase() === "approved"
  );

  const pendingApplications = applications.filter((item) =>
    String(item.status || "").toLowerCase() === "pending"
  );

  const activated = recruited.filter((item) => item.network_status === "activated");

  const summary = {
    recruited_total: recruited.length,
    pending_total: pendingApplications.length,
    approved_applications_total: approvedApplications.length,
    active_total: recruited.filter((item) => item.recruited_status === "active").length,
    activated_total: activated.length,
    recruited_total_sales: recruited.reduce((sum, item) => sum + Number(item.recruited_total_sales || 0), 0),
    recruited_total_commission: recruited.reduce((sum, item) => sum + Number(item.recruited_total_commission || 0), 0),
    recruitment_bonus_total: recruited.reduce((sum, item) => sum + Number(item.recruiter_bonus_from_recruited || 0), 0),
  };

  return {
    affiliate,
    summary,
    recruited,
    applications,
  };
}

export async function deleteAffiliate(id) {
  const affiliateId = cleanText(id);

  if (!affiliateId) {
    throw new Error("ID do afiliado é obrigatório.");
  }

  const affiliate = await getAffiliateById(affiliateId);

  if (!affiliate) {
    throw new Error("Afiliado não encontrado.");
  }

  async function hasRelatedRows(tableName) {
    const params = new URLSearchParams();
    params.set("select", "id");
    params.set("affiliate_id", `eq.${affiliateId}`);
    params.set("limit", "1");

    const rows = await supabaseRequest(`/${tableName}?${params.toString()}`);
    return Array.isArray(rows) && Boolean(rows[0]?.id);
  }

  const hasConversions = await hasRelatedRows("affiliate_conversions");
  const hasPayouts = await hasRelatedRows("affiliate_payouts");

  const ordersParams = new URLSearchParams();
  ordersParams.set("select", "id");
  ordersParams.set("affiliate_id", `eq.${affiliateId}`);
  ordersParams.set("limit", "1");

  const orders = await supabaseRequest(`/orders?${ordersParams.toString()}`);
  const hasOrders = Array.isArray(orders) && Boolean(orders[0]?.id);

  if (hasConversions || hasPayouts || hasOrders) {
    throw new Error(
      "Este afiliado já possui histórico de vendas, comissões ou pagamentos. Para preservar o financeiro, bloqueie em vez de excluir."
    );
  }

  await supabaseRequest(`/affiliate_applications?affiliate_id=eq.${affiliateId}`, {
    method: "PATCH",
    headers: {
      Prefer: "return=representation",
    },
    body: JSON.stringify({
      affiliate_id: null,
      admin_notes:
        "Afiliado de teste excluído pelo painel admin; vínculo da solicitação removido.",
      updated_at: new Date().toISOString(),
    }),
  });

  const deleted = await supabaseRequest(`/affiliates?id=eq.${affiliateId}`, {
    method: "DELETE",
    headers: {
      Prefer: "return=representation",
    },
  });

  return deleted?.[0] || affiliate;
}

export async function listAffiliateLevels() {
  const params = new URLSearchParams();
  params.set("select", "*");
  params.set("order", "level_order.asc");

  const rows = await supabaseRequest(`/affiliate_levels?${params.toString()}`);
  return Array.isArray(rows) ? rows : [];
}

export async function listAffiliateGoalOverview(filters = {}) {
  const search = cleanText(filters.search);
  const status = cleanText(filters.status);
  const levelName = cleanText(filters.level_name || filters.levelName);
  const affiliateId = cleanText(filters.affiliate_id || filters.affiliateId);

  const params = new URLSearchParams();
  params.set("select", "*");
  params.set("order", "full_name.asc");

  if (affiliateId) {
    params.set("affiliate_id", `eq.${affiliateId}`);
  }

  if (status) {
    params.set("status", `eq.${status}`);
  }

  if (levelName) {
    params.set("current_level_name", `eq.${levelName}`);
  }

  if (search) {
    params.set(
      "or",
      `(full_name.ilike.*${search}*,email.ilike.*${search}*)`
    );
  }

  const rows = await supabaseRequest(`/affiliate_goal_overview?${params.toString()}`);
  return Array.isArray(rows) ? rows : [];
}

export async function listAffiliateBonusOverview(filters = {}) {
  const search = cleanText(filters.search);
  const status = cleanText(filters.status);
  const affiliateId = cleanText(filters.affiliate_id || filters.affiliateId);
  const levelName = cleanText(filters.level_name || filters.levelName);

  const params = new URLSearchParams();
  params.set("select", "*");
  params.set("order", "released_at.desc");

  if (affiliateId) {
    params.set("affiliate_id", `eq.${affiliateId}`);
  }

  if (status) {
    params.set("status", `eq.${status}`);
  }

  if (levelName) {
    params.set("level_name", `eq.${levelName}`);
  }

  if (search) {
    params.set(
      "or",
      `(full_name.ilike.*${search}*,email.ilike.*${search}*,level_name.ilike.*${search}*)`
    );
  }

  const rows = await supabaseRequest(`/affiliate_bonus_overview?${params.toString()}`);
  return Array.isArray(rows) ? rows : [];
}

export async function processAffiliateLevelProgress(id) {
  const affiliateId = cleanText(id);

  if (!affiliateId) {
    throw new Error("ID do afiliado é obrigatório.");
  }

  const rows = await supabaseRequest("/rpc/process_affiliate_level_progress", {
    method: "POST",
    headers: {
      Prefer: "return=representation",
    },
    body: JSON.stringify({
      p_affiliate_id: affiliateId,
    }),
  });

  const result = Array.isArray(rows) ? rows[0] : rows;
  const resultAffiliateId =
    result?.affiliate_id ||
    result?.affiliateId ||
    result?.p_affiliate_id ||
    affiliateId;

  if (
    result &&
    resultAffiliateId &&
    !["no_change", "unchanged", "skipped"].includes(String(result?.status || result?.result || "").toLowerCase())
  ) {
    await safeAffiliatePush("affiliate_level_progress", resultAffiliateId, {
      title: "🎯 Meta",
      body: "Sua evolução foi atualizada. Abra o painel para ver nível e bônus.",
      url: "/pages-html/afiliado-painel.html",
      data: {
        type: "affiliate_level_progress",
        affiliate_id: resultAffiliateId,
        result,
      },
    });
  }

  return result;
}

export async function updateAffiliateLevelBonusStatus(id, input = {}) {
  const bonusId = cleanText(id || input.id || input.bonus_id || input.bonusId);
  const status = cleanText(input.status).toLowerCase();
  const adminNotes = cleanText(input.admin_notes || input.adminNotes || input.notes);

  if (!bonusId) {
    throw new Error("ID do bônus é obrigatório.");
  }

  if (!status) {
    throw new Error("Informe o novo status do bônus.");
  }

  if (!["pending", "approved", "paid", "cancelled"].includes(status)) {
    throw new Error("Status inválido. Use pending, approved, paid ou cancelled.");
  }

  const rows = await supabaseRequest("/rpc/update_affiliate_level_bonus_status", {
    method: "POST",
    headers: {
      Prefer: "return=representation",
    },
    body: JSON.stringify({
      p_bonus_id: bonusId,
      p_status: status,
      p_admin_notes: adminNotes || null,
    }),
  });

  const result = Array.isArray(rows) ? rows[0] : rows;
  const affiliateId = result?.affiliate_id || result?.affiliateId || result?.affiliate;
  const bonusAmount = result?.bonus_amount || result?.amount || result?.current_bonus_amount || 0;
  const levelName = result?.level_name || result?.current_level_name || result?.level || "";

  if (affiliateId && ["approved", "paid"].includes(status)) {
    await safeAffiliatePush("affiliate_level_bonus_status", affiliateId, {
      title: status === "paid" ? "💰 Bônus pago" : "🎁 Bônus",
      body:
        status === "paid"
          ? `Seu bônus ${levelName ? `do nível ${levelName} ` : ""}foi marcado como pago. Valor: ${formatMoneyBR(bonusAmount)}.`
          : `Seu bônus ${levelName ? `do nível ${levelName} ` : ""}foi aprovado. Valor: ${formatMoneyBR(bonusAmount)}.`,
      url: "/pages-html/afiliado-painel.html",
      data: {
        type: "affiliate_level_bonus_status",
        affiliate_id: affiliateId,
        bonus_id: bonusId,
        status,
        amount: bonusAmount,
      },
    });
  }

  return result;
}
