import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { env } from "../config/env.js";
import { notifyAffiliatePasswordReset } from "./affiliateNotification.service.js";

const AFFILIATE_TOKEN_EXPIRES_IN = "7d";


async function supabaseRequest(endpoint, options = {}) {
  const method = options.method || "GET";
  const url = `${env.supabaseUrl}/rest/v1${endpoint}`;

  const headers = {
    apikey: env.supabaseServiceRoleKey,
    Authorization: `Bearer ${env.supabaseServiceRoleKey}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    ...(options.headers || {}),
  };

  if (["POST", "PUT", "PATCH", "DELETE"].includes(method.toUpperCase())) {
    headers.Prefer = options.headers?.Prefer || "return=representation";
  }

  const response = await fetch(url, {
    method,
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const text = await response.text();

  if (!response.ok) {
    let details = text;

    try {
      details = JSON.parse(text);
    } catch {
      // mantém texto original
    }

    console.error("SUPABASE REQUEST ERROR:", {
      method,
      endpoint,
      status: response.status,
      details,
    });

    const error = new Error("Erro ao consultar dados do afiliado.");
    error.statusCode = response.status;
    error.details = details;
    throw error;
  }

  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}


function getJwtSecret() {
  const secret = process.env.JWT_SECRET || process.env.jwtSecret;

  if (!secret) {
    throw new Error("JWT_SECRET não configurado no backend.");
  }

  return secret;
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function normalizeMoney(value) {
  const number = Number(value || 0);

  if (!Number.isFinite(number)) {
    return 0;
  }

  return number;
}

function maskEmail(email) {
  const cleanEmail = String(email || "").trim().toLowerCase();

  if (!cleanEmail || !cleanEmail.includes("@")) {
    return "";
  }

  const [name, domain] = cleanEmail.split("@");
  const first = name.slice(0, 1);
  const last = name.length > 2 ? name.slice(-1) : "";

  return `${first}${"*".repeat(Math.max(name.length - 2, 3))}${last}@${domain}`;
}

function maskName(name) {
  const cleanName = String(name || "").trim();

  if (!cleanName) {
    return "Cliente";
  }

  const parts = cleanName.split(/\s+/).filter(Boolean);
  const firstName = parts[0] || "Cliente";
  const lastInitial = parts.length > 1 ? `${parts[parts.length - 1][0]}.` : "";

  return [firstName, lastInitial].filter(Boolean).join(" ");
}

function buildAffiliatePayload(affiliate) {
  return {
    id: affiliate.id,
    full_name: affiliate.full_name,
    email: affiliate.email,
    phone: affiliate.phone || null,
    ref_code: affiliate.ref_code,
    coupon_code: affiliate.coupon_code || null,
    status: affiliate.status || "active",
    commission_rate: normalizeMoney(affiliate.commission_rate),
    pix_key: affiliate.pix_key || null,
    pix_key_type: affiliate.pix_key_type || null,
    created_at: affiliate.created_at || null,
  };
}

function signAffiliateToken(affiliate) {
  return jwt.sign(
    {
      type: "affiliate",
      affiliate_id: affiliate.id,
      email: affiliate.email,
    },
    getJwtSecret(),
    {
      expiresIn: AFFILIATE_TOKEN_EXPIRES_IN,
    }
  );
}

export function verifyAffiliateToken(token) {
  const decoded = jwt.verify(token, getJwtSecret());

  if (!decoded || decoded.type !== "affiliate" || !decoded.affiliate_id) {
    throw new Error("Token de afiliado inválido.");
  }

  return decoded;
}

export async function loginAffiliate({ email, password }) {
  const normalizedEmail = normalizeEmail(email);

  if (!normalizedEmail || !password) {
    const error = new Error("Informe e-mail e senha.");
    error.statusCode = 400;
    throw error;
  }

  const affiliates = await supabaseRequest(
    `/affiliates?email=eq.${encodeURIComponent(
      normalizedEmail
    )}&select=id,full_name,email,phone,ref_code,coupon_code,status,commission_rate,password_hash,access_enabled,pix_key,pix_key_type,created_at&limit=1`
  );

  const affiliate = Array.isArray(affiliates) ? affiliates[0] : null;

  if (!affiliate) {
    const error = new Error("E-mail ou senha inválidos.");
    error.statusCode = 401;
    throw error;
  }

  if (affiliate.access_enabled === false) {
    const error = new Error("Acesso do afiliado desativado.");
    error.statusCode = 403;
    throw error;
  }

  const normalizedStatus = String(affiliate.status || "active")
  .trim()
  .toLowerCase();

const activeStatuses = ["active", "ativo"];

if (!activeStatuses.includes(normalizedStatus)) {
  const error = new Error("Afiliado não está ativo.");
  error.statusCode = 403;
  throw error;
}

  if (!affiliate.password_hash) {
    const error = new Error(
      "Afiliado ainda não possui senha cadastrada. Solicite ao administrador."
    );
    error.statusCode = 403;
    throw error;
  }

  const passwordMatches = await bcrypt.compare(
    String(password),
    affiliate.password_hash
  );

  if (!passwordMatches) {
    const error = new Error("E-mail ou senha inválidos.");
    error.statusCode = 401;
    throw error;
  }

  await supabaseRequest(`/affiliates?id=eq.${affiliate.id}`, {
    method: "PATCH",
    body: {
      last_login_at: new Date().toISOString(),
    },
  });

  const token = signAffiliateToken(affiliate);

  return {
    token,
    affiliate: buildAffiliatePayload(affiliate),
  };
}

export async function getAffiliateById(affiliateId) {
  const affiliates = await supabaseRequest(
    `/affiliates?id=eq.${encodeURIComponent(
      affiliateId
    )}&select=id,full_name,email,phone,ref_code,coupon_code,status,commission_rate,access_enabled,pix_key,pix_key_type,created_at&limit=1`
  );

  const affiliate = Array.isArray(affiliates) ? affiliates[0] : null;

  if (!affiliate) {
    const error = new Error("Afiliado não encontrado.");
    error.statusCode = 404;
    throw error;
  }

  if (affiliate.access_enabled === false) {
    const error = new Error("Acesso do afiliado desativado.");
    error.statusCode = 403;
    throw error;
  }

  return buildAffiliatePayload(affiliate);
}

export async function getAffiliateSummary(affiliateId) {
  const affiliate = await getAffiliateById(affiliateId);

  const [orders, payouts] = await Promise.all([
    supabaseRequest(
      `/orders?affiliate_id=eq.${encodeURIComponent(
        affiliateId
      )}&select=id,total_amount,affiliate_commission_amount,affiliate_commission_status,payment_status,order_status,created_at`
    ),
    supabaseRequest(
      `/affiliate_payouts?affiliate_id=eq.${encodeURIComponent(
        affiliateId
      )}&select=id,amount,status,created_at`
    ),
  ]);

  const safeOrders = Array.isArray(orders) ? orders : [];
  const safePayouts = Array.isArray(payouts) ? payouts : [];

  const summary = safeOrders.reduce(
    (acc, order) => {
      const total = normalizeMoney(order.total_amount);
      const commission = normalizeMoney(order.affiliate_commission_amount);
      const commissionStatus = String(
        order.affiliate_commission_status || "pending"
      ).toLowerCase();

      acc.total_conversions += 1;
      acc.total_referred_sales += total;

      if (commissionStatus === "approved") {
        acc.approved_commission += commission;
      } else if (commissionStatus === "released") {
        acc.released_commission += commission;
      } else if (commissionStatus === "paid") {
        acc.paid_commission_by_conversion += commission;
      } else {
        acc.pending_commission += commission;
      }

      return acc;
    },
    {
      total_conversions: 0,
      total_referred_sales: 0,
      pending_commission: 0,
      approved_commission: 0,
      released_commission: 0,
      paid_commission_by_conversion: 0,
      total_paid: 0,
      balance_to_pay: 0,
    }
  );

  summary.total_paid = safePayouts.reduce((acc, payout) => {
    const status = String(payout.status || "").toLowerCase();

    if (status === "paid" || status === "completed" || status === "approved") {
      return acc + normalizeMoney(payout.amount);
    }

    return acc;
  }, 0);

  summary.balance_to_pay = Math.max(
    summary.released_commission + summary.approved_commission - summary.total_paid,
    0
  );

  return {
    affiliate,
    summary,
  };
}

export async function getAffiliateOrders(affiliateId) {
  const orders = await supabaseRequest(
    `/orders?affiliate_id=eq.${encodeURIComponent(
      affiliateId
    )}&select=id,order_number,customer_name,customer_email,total_amount,affiliate_commission_amount,affiliate_commission_status,payment_status,order_status,created_at&order=created_at.desc&limit=100`
  );

  const safeOrders = Array.isArray(orders) ? orders : [];

  return safeOrders.map((order) => ({
    id: order.id,
    order_number: order.order_number,
    customer_name: maskName(order.customer_name),
    customer_email: maskEmail(order.customer_email),
    total_amount: normalizeMoney(order.total_amount),
    commission_amount: normalizeMoney(order.affiliate_commission_amount),
    commission_status: order.affiliate_commission_status || "pending",
    payment_status: order.payment_status || null,
    order_status: order.order_status || null,
    created_at: order.created_at || null,
  }));
}

export async function getAffiliatePayouts(affiliateId) {
  const payouts = await supabaseRequest(
    `/affiliate_payouts?affiliate_id=eq.${encodeURIComponent(
      affiliateId
    )}&select=id,amount,status,payment_method,payment_reference,receipt_url,receipt_path,notes,created_at,paid_at&order=created_at.desc&limit=100`
  );

  const safePayouts = Array.isArray(payouts) ? payouts : [];

  return safePayouts.map((payout) => ({
    id: payout.id,
    amount: normalizeMoney(payout.amount),
    status: payout.status || "pending",
    payment_method: payout.payment_method || null,
    payment_reference: payout.payment_reference || null,
    receipt_url: payout.receipt_url || null,
    receipt_path: payout.receipt_path || null,
    notes: payout.notes || null,
    created_at: payout.created_at || null,
    paid_at: payout.paid_at || null,
  }));
}

export async function updateAffiliateProfile(affiliateId, payload = {}) {
  const allowedPixTypes = ["cpf", "cnpj", "email", "phone", "random"];
  const pixKey = String(payload.pix_key || "").trim();
  const pixKeyType = String(payload.pix_key_type || "").trim().toLowerCase();

  if (!pixKey) {
    const error = new Error("Informe a chave Pix.");
    error.statusCode = 400;
    throw error;
  }

  if (!allowedPixTypes.includes(pixKeyType)) {
    const error = new Error("Tipo de chave Pix inválido.");
    error.statusCode = 400;
    throw error;
  }

  await supabaseRequest(`/affiliates?id=eq.${encodeURIComponent(affiliateId)}`, {
    method: "PATCH",
    body: {
      pix_key: pixKey,
      pix_key_type: pixKeyType,
      updated_at: new Date().toISOString(),
    },
  });

  return getAffiliateById(affiliateId);
}


function generateTemporaryPassword() {
  const prefix = "OZ";
  const random = crypto.randomBytes(4).toString("hex").toUpperCase();
  const suffix = Math.floor(100 + Math.random() * 900);

  return `${prefix}${random}@${suffix}`;
}

function isAffiliateActive(affiliate = {}) {
  const normalizedStatus = String(affiliate.status || "active")
    .trim()
    .toLowerCase();

  const activeStatuses = ["active", "ativo"];

  return activeStatuses.includes(normalizedStatus) && affiliate.access_enabled !== false;
}

export async function requestAffiliatePasswordReset({ email } = {}) {
  const normalizedEmail = normalizeEmail(email);

  if (!normalizedEmail) {
    const error = new Error("Informe o Gmail cadastrado.");
    error.statusCode = 400;
    throw error;
  }

  const affiliates = await supabaseRequest(
    `/affiliates?email=eq.${encodeURIComponent(
      normalizedEmail
    )}&select=id,full_name,email,phone,ref_code,coupon_code,status,commission_rate,password_hash,access_enabled,pix_key,pix_key_type,created_at&limit=1`
  );

  const affiliate = Array.isArray(affiliates) ? affiliates[0] : null;

  /*
    Resposta propositalmente genérica:
    evita expor se um e-mail existe ou não no sistema.
  */
  if (!affiliate) {
    return {
      sent: false,
      skipped: true,
      reason: "affiliate_not_found",
    };
  }

  if (!isAffiliateActive(affiliate)) {
    return {
      sent: false,
      skipped: true,
      reason: "affiliate_not_active",
    };
  }

  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await bcrypt.hash(temporaryPassword, 10);

  await supabaseRequest(`/affiliates?id=eq.${encodeURIComponent(affiliate.id)}`, {
    method: "PATCH",
    body: {
      password_hash: passwordHash,
      updated_at: new Date().toISOString(),
    },
  });

  const notification = await notifyAffiliatePasswordReset(
    affiliate,
    temporaryPassword
  );

  return {
    sent: Boolean(notification?.sent),
    skipped: Boolean(notification?.skipped),
    notification,
  };
}

export async function checkAffiliateAccessByEmail({ email } = {}) {
  const normalizedEmail = normalizeEmail(email);

  if (!normalizedEmail) {
    const error = new Error("Informe o Gmail.");
    error.statusCode = 400;
    throw error;
  }

  const affiliates = await supabaseRequest(
    `/affiliates?email=eq.${encodeURIComponent(
      normalizedEmail
    )}&select=id,full_name,email,status,access_enabled,password_hash,ref_code&limit=1`
  );

  const affiliate = Array.isArray(affiliates) ? affiliates[0] : null;

  if (affiliate) {
    const active = isAffiliateActive(affiliate);

    if (active) {
      return {
        exists: true,
        type: "affiliate",
        status: "approved",
        shouldRedirectToLogin: true,
        email: normalizedEmail,
        message: "Seu cadastro já foi aprovado. Faça login para acessar seu painel.",
      };
    }

    return {
      exists: true,
      type: "affiliate",
      status: affiliate.status || "inactive",
      shouldRedirectToLogin: false,
      email: normalizedEmail,
      message: "Seu cadastro existe, mas o acesso ao painel ainda não está ativo.",
    };
  }

  const applications = await supabaseRequest(
    `/affiliate_applications?email=eq.${encodeURIComponent(
      normalizedEmail
    )}&select=id,email,status,affiliate_id,created_at&order=created_at.desc&limit=1`
  );

  const application = Array.isArray(applications) ? applications[0] : null;

  if (application) {
    const status = String(application.status || "").toLowerCase();

    if (status === "pending") {
      return {
        exists: true,
        type: "application",
        status: "pending",
        shouldRedirectToLogin: false,
        email: normalizedEmail,
        message: "Seu cadastro de afiliado ainda está em análise.",
      };
    }

    if (status === "approved") {
      return {
        exists: true,
        type: "application",
        status: "approved",
        shouldRedirectToLogin: true,
        email: normalizedEmail,
        message: "Seu cadastro já foi aprovado. Faça login para acessar seu painel.",
      };
    }

    if (status === "rejected") {
      return {
        exists: true,
        type: "application",
        status: "rejected",
        shouldRedirectToLogin: false,
        email: normalizedEmail,
        message: "Sua solicitação de afiliado não foi aprovada.",
      };
    }
  }

  return {
    exists: false,
    type: "none",
    status: "not_found",
    shouldRedirectToLogin: false,
    email: normalizedEmail,
    message: "Nenhum cadastro encontrado para este Gmail.",
  };
}