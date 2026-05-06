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


function normalizeStatus(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function isReleasedLikeStatus(value) {
  return [
    "released",
    "liberado",
    "available",
    "disponivel",
    "ready",
    "paid",
    "pago",
  ].includes(normalizeStatus(value));
}

function isPaidConversionStatus(value) {
  return ["paid", "pago"].includes(normalizeStatus(value));
}

function isApprovedLikeStatus(value) {
  return [
    "approved",
    "aprovado",
    "pending",
    "pendente",
    "created",
    "criado",
  ].includes(normalizeStatus(value));
}

function isDeliveredLikeStatus(value) {
  return [
    "delivered",
    "entregue",
    "received",
    "recebido",
    "delivery_completed",
    "completed_delivery",
    "finalizado",
    "delivered_to_recipient",
    "entrega_realizada",
    "objeto_entregue",
  ].includes(normalizeStatus(value));
}

function isShippedLikeStatus(value) {
  return [
    "shipped",
    "enviado",
    "sent",
    "posted",
    "postado",
    "dispatch",
    "dispatched",
    "in_transit",
    "em_transito",
    "transito",
    "transporting",
    "a_caminho",
    "on_the_way",
    "out_for_delivery",
    "saiu_para_entrega",
    "generated",
    "gerada",
    "cart_created",
  ].includes(normalizeStatus(value));
}

function isCancelledLikeStatus(value) {
  return [
    "cancelled",
    "canceled",
    "cancelado",
    "cancelada",
    "rejected",
    "rejeitado",
    "rejeitada",
    "failed",
    "falhou",
    "refunded",
    "estornado",
    "estornada",
    "charged_back",
    "chargeback",
  ].includes(normalizeStatus(value));
}

function isSaleCommission(conversion = {}) {
  const type = normalizeStatus(conversion.conversion_type || "sale_commission");

  return !type || type === "sale_commission" || type === "sale" || type === "order";
}

function isRecruitmentCommission(conversion = {}) {
  const type = normalizeStatus(conversion.conversion_type);

  return [
    "recruitment_bonus",
    "recruitment_commission",
    "network_commission",
  ].includes(type);
}

function getConversionCommissionAmount(conversion = {}) {
  return normalizeMoney(
    conversion.commission_amount ??
      conversion.recruitment_bonus_amount ??
      conversion.network_commission ??
      0
  );
}

function getConversionOrderTotal(conversion = {}, order = {}) {
  return normalizeMoney(
    order.total_amount ??
      conversion.order_total ??
      0
  );
}

function isOrderCancelled(order = {}) {
  return (
    isCancelledLikeStatus(order.order_status) ||
    isCancelledLikeStatus(order.payment_status) ||
    isCancelledLikeStatus(order.payment_raw_status)
  );
}

function isOrderDelivered(order = {}) {
  return (
    isDeliveredLikeStatus(order.order_status) ||
    isDeliveredLikeStatus(order.shipping_status) ||
    isDeliveredLikeStatus(order.delivery_status) ||
    isDeliveredLikeStatus(order.tracking_status) ||
    Boolean(order.delivered_at)
  );
}

function isOrderInShipping(order = {}) {
  return (
    isShippedLikeStatus(order.order_status) ||
    isShippedLikeStatus(order.shipping_label_status) ||
    isShippedLikeStatus(order.shipping_status) ||
    isShippedLikeStatus(order.delivery_status) ||
    isShippedLikeStatus(order.tracking_status) ||
    Boolean(order.shipping_tracking_code || order.tracking_code || order.shipped_at)
  );
}

function getAffiliateOrderLifecycle({ conversion = {}, order = {} } = {}) {
  if (isCancelledLikeStatus(conversion.status) || isOrderCancelled(order)) {
    return "cancelled";
  }

  if (isReleasedLikeStatus(conversion.status) || isOrderDelivered(order)) {
    return "delivered";
  }

  if (isApprovedLikeStatus(conversion.status) || isOrderInShipping(order)) {
    return "pending_shipping";
  }

  return "pending_payment";
}

function getFriendlyAffiliateCommissionStatus({ conversion = {}, order = {} } = {}) {
  const lifecycle = getAffiliateOrderLifecycle({ conversion, order });

  if (lifecycle === "cancelled") {
    return "cancelled";
  }

  if (lifecycle === "delivered") {
    return "released";
  }

  if (lifecycle === "pending_shipping") {
    return "pending_shipping";
  }

  return normalizeStatus(conversion.status || "pending");
}

async function getOrdersByIds(orderIds = []) {
  const ids = Array.from(
    new Set(
      orderIds
        .map((id) => String(id || "").trim())
        .filter(Boolean)
    )
  );

  if (!ids.length) {
    return [];
  }

  const chunkSize = 80;
  const orders = [];

  for (let index = 0; index < ids.length; index += chunkSize) {
    const chunk = ids.slice(index, index + chunkSize);
    const data = await supabaseRequest(
      `/orders?id=in.(${chunk.join(",")})&select=id,order_number,customer_name,customer_email,total_amount,payment_status,payment_raw_status,order_status,shipping_label_status,shipping_tracking_code,tracking_code,shipped_at,delivered_at,created_at`
    );

    if (Array.isArray(data)) {
      orders.push(...data);
    }
  }

  return orders;
}

function buildOrderMap(orders = []) {
  const map = new Map();

  orders.forEach((order) => {
    const id = String(order?.id || "").trim();

    if (id) {
      map.set(id, order);
    }
  });

  return map;
}

async function getAffiliateOrdersTableRows(affiliateId, { limit = 500 } = {}) {
  const data = await supabaseRequest(
    `/orders?affiliate_id=eq.${encodeURIComponent(
      affiliateId
    )}&select=id,order_number,customer_name,customer_email,total_amount,affiliate_commission_amount,affiliate_commission_status,payment_status,payment_raw_status,order_status,shipping_label_status,shipping_tracking_code,tracking_code,shipped_at,delivered_at,created_at&order=created_at.desc&limit=${Number(limit) || 500}`
  );

  return Array.isArray(data) ? data : [];
}

function getCancelledOrdersCountFromOrders(orders = []) {
  const ids = new Set();

  orders.forEach((order) => {
    if (isOrderCancelled(order)) {
      ids.add(String(order.id || order.order_number || "").trim());
    }
  });

  return Array.from(ids).filter(Boolean).length;
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

  /*
    Processa a evolução do afiliado antes de montar o resumo.
    Segurança:
    - A função do banco só libera bônus se a meta realmente foi batida.
    - Se ainda não bateu a meta, ela apenas retorna "Meta ainda não concluída".
    - Não cria bônus duplicado por causa da trava unique no banco.
  */
  try {
    await supabaseRequest("/rpc/process_affiliate_level_progress", {
      method: "POST",
      body: {
        p_affiliate_id: affiliateId,
      },
    });
  } catch (error) {
    console.error("AFFILIATE LEVEL PROCESS ERROR:", {
      affiliateId,
      message: error?.message,
      details: error?.details,
    });
  }

  const [conversions, payouts, goalRows, bonusRows, affiliateOrdersTableRows] = await Promise.all([
    supabaseRequest(
      `/affiliate_conversions?affiliate_id=eq.${encodeURIComponent(
        affiliateId
      )}&select=id,affiliate_id,order_id,customer_id,ref_code,coupon_code,order_total,commission_rate,commission_amount,conversion_type,recruited_affiliate_id,seller_affiliate_id,recruitment_bonus_amount,status,approved_at,released_at,created_at&order=created_at.desc&limit=500`
    ),
    supabaseRequest(
      `/affiliate_payouts?affiliate_id=eq.${encodeURIComponent(
        affiliateId
      )}&select=id,amount,status,created_at`
    ),
    supabaseRequest(
      `/affiliate_goal_overview?affiliate_id=eq.${encodeURIComponent(
        affiliateId
      )}&select=*&limit=1`
    ),
    supabaseRequest(
      `/affiliate_bonus_overview?affiliate_id=eq.${encodeURIComponent(
        affiliateId
      )}&select=*&order=released_at.desc&limit=50`
    ),
    getAffiliateOrdersTableRows(affiliateId),
  ]);

  const safeConversions = Array.isArray(conversions) ? conversions : [];
  const safePayouts = Array.isArray(payouts) ? payouts : [];
  const safeAffiliateOrdersTableRows = Array.isArray(affiliateOrdersTableRows)
    ? affiliateOrdersTableRows
    : [];
  const goal = Array.isArray(goalRows) ? goalRows[0] : null;
  const bonuses = Array.isArray(bonusRows) ? bonusRows : [];

  const conversionOrders = await getOrdersByIds(
    safeConversions.map((conversion) => conversion.order_id)
  );

  const allOrdersMap = buildOrderMap([
    ...safeAffiliateOrdersTableRows,
    ...conversionOrders,
  ]);

  const orders = Array.from(allOrdersMap.values());
  const orderMap = buildOrderMap(orders);

  const summary = safeConversions.reduce(
    (acc, conversion) => {
      const order = orderMap.get(String(conversion.order_id || "")) || {};
      const commission = getConversionCommissionAmount(conversion);
      const total = getConversionOrderTotal(conversion, order);
      const lifecycle = getAffiliateOrderLifecycle({ conversion, order });

      if (isRecruitmentCommission(conversion)) {
        if (isCancelledLikeStatus(conversion.status) || lifecycle === "cancelled") {
          return acc;
        }

        acc.network_commission_total += commission;
        acc.recruitment_bonus_total += commission;

        if (isReleasedLikeStatus(conversion.status)) {
          acc.released_commission += commission;
        } else {
          acc.approved_commission += commission;
        }

        return acc;
      }

      if (!isSaleCommission(conversion)) {
        return acc;
      }

      if (lifecycle === "cancelled") {
        acc.canceled_orders_count += 1;
        return acc;
      }

      acc.total_conversions += 1;
      acc.total_referred_sales += total;

      if (lifecycle === "delivered" || isReleasedLikeStatus(conversion.status)) {
        acc.released_commission += commission;
      } else if (isPaidConversionStatus(conversion.status)) {
        acc.paid_commission_by_conversion += commission;
      } else {
        /*
          A comissão criada após pagamento fica aqui até a entrega ao cliente final.
          Isso cobre o teste de pagamento simulado e também pedidos com etiqueta/rastreio.
        */
        acc.pending_shipping_balance += commission;
        acc.pending_commission += commission;
      }

      return acc;
    },
    {
      total_conversions: 0,
      total_referred_sales: 0,
      pending_commission: 0,
      pending_shipping_balance: 0,
      approved_commission: 0,
      released_commission: 0,
      paid_commission_by_conversion: 0,
      network_commission_total: 0,
      recruitment_bonus_total: 0,
      canceled_orders_count: 0,
      total_paid: 0,
      balance_to_pay: 0,
    }
  );

  summary.canceled_orders_count = Math.max(
    summary.canceled_orders_count,
    getCancelledOrdersCountFromOrders(orders)
  );

  summary.total_paid = safePayouts.reduce((acc, payout) => {
    const status = String(payout.status || "").toLowerCase();

    if (status === "paid" || status === "completed" || status === "approved") {
      return acc + normalizeMoney(payout.amount);
    }

    return acc;
  }, 0);

  summary.balance_to_pay = Math.max(
    summary.released_commission + summary.paid_commission_by_conversion - summary.total_paid,
    0
  );

  const level_goal = goal
    ? {
        affiliate_id: goal.affiliate_id,
        current_level_order: Number(goal.current_level_order || 1),
        current_level_name: goal.current_level_name || "Iniciante",
        current_goal: Number(goal.current_goal || 3),
        paid_conversions: Number(goal.paid_conversions || 0),
        progress_percent: Number(goal.progress_percent || 0),
        remaining_to_goal: Number(goal.remaining_to_goal || 0),
        current_bonus_amount: normalizeMoney(goal.current_bonus_amount),
        current_bonus_type: goal.current_bonus_type || "money",
        next_level_order: goal.next_level_order || null,
        next_level_name: goal.next_level_name || null,
        pending_bonus_amount: normalizeMoney(goal.pending_bonus_amount),
        paid_bonus_amount: normalizeMoney(goal.paid_bonus_amount),
        total_bonus_amount: normalizeMoney(goal.total_bonus_amount),
      }
    : {
        affiliate_id: affiliateId,
        current_level_order: 1,
        current_level_name: "Iniciante",
        current_goal: 3,
        paid_conversions: 0,
        progress_percent: 0,
        remaining_to_goal: 3,
        current_bonus_amount: 20,
        current_bonus_type: "money",
        next_level_order: 2,
        next_level_name: "Bronze",
        pending_bonus_amount: 0,
        paid_bonus_amount: 0,
        total_bonus_amount: 0,
      };

  const level_bonuses = bonuses.map((bonus) => ({
    id: bonus.id,
    affiliate_id: bonus.affiliate_id,
    level_order: Number(bonus.level_order || 0),
    level_name: bonus.level_name,
    bonus_amount: normalizeMoney(bonus.bonus_amount),
    bonus_type: bonus.bonus_type || "money",
    status: bonus.status || "pending",
    released_at: bonus.released_at || null,
    approved_at: bonus.approved_at || null,
    paid_at: bonus.paid_at || null,
    admin_notes: bonus.admin_notes || null,
    created_at: bonus.created_at || null,
  }));

  return {
    affiliate,
    summary,
    level_goal,
    level_bonuses,
  };
}

export async function getAffiliateOrders(affiliateId) {
  const [conversions, affiliateOrdersTableRows] = await Promise.all([
    supabaseRequest(
      `/affiliate_conversions?affiliate_id=eq.${encodeURIComponent(
        affiliateId
      )}&conversion_type=eq.sale_commission&select=id,affiliate_id,order_id,customer_id,ref_code,coupon_code,order_total,commission_rate,commission_amount,conversion_type,status,approved_at,released_at,created_at&order=created_at.desc&limit=100`
    ),
    getAffiliateOrdersTableRows(affiliateId, { limit: 100 }),
  ]);

  const safeConversions = Array.isArray(conversions) ? conversions : [];
  const safeAffiliateOrdersTableRows = Array.isArray(affiliateOrdersTableRows)
    ? affiliateOrdersTableRows
    : [];

  const conversionOrders = await getOrdersByIds(
    safeConversions.map((conversion) => conversion.order_id)
  );

  const orderMap = buildOrderMap([
    ...safeAffiliateOrdersTableRows,
    ...conversionOrders,
  ]);

  const rowsFromConversions = safeConversions.map((conversion) => {
    const order = orderMap.get(String(conversion.order_id || "")) || {};
    const lifecycle = getAffiliateOrderLifecycle({ conversion, order });

    return {
      id: order.id || conversion.order_id || conversion.id,
      conversion_id: conversion.id,
      order_id: conversion.order_id || null,
      order_number: order.order_number || conversion.order_id || "Pedido",
      customer_name: maskName(order.customer_name),
      customer_email: maskEmail(order.customer_email),
      total_amount: getConversionOrderTotal(conversion, order),
      commission_amount: getConversionCommissionAmount(conversion),
      commission_status: getFriendlyAffiliateCommissionStatus({ conversion, order }),
      affiliate_commission_status: conversion.status || "pending",
      payment_status: order.payment_status || null,
      payment_raw_status: order.payment_raw_status || null,
      order_status: order.order_status || null,
      shipping_label_status: order.shipping_label_status || null,
      shipping_tracking_code: order.shipping_tracking_code || null,
      tracking_code: order.tracking_code || null,
      shipped_at: order.shipped_at || null,
      delivered_at: order.delivered_at || null,
      affiliate_order_lifecycle: lifecycle,
      created_at: order.created_at || conversion.created_at || null,
    };
  });

  const conversionOrderIds = new Set(
    safeConversions.map((conversion) => String(conversion.order_id || "").trim())
  );

  const tableOnlyRows = safeAffiliateOrdersTableRows
    .filter((order) => {
      const orderId = String(order.id || "").trim();

      return orderId && !conversionOrderIds.has(orderId) && isOrderCancelled(order);
    })
    .map((order) => ({
      id: order.id,
      conversion_id: null,
      order_id: order.id,
      order_number: order.order_number || order.id,
      customer_name: maskName(order.customer_name),
      customer_email: maskEmail(order.customer_email),
      total_amount: normalizeMoney(order.total_amount),
      commission_amount: normalizeMoney(order.affiliate_commission_amount),
      commission_status: "cancelled",
      affiliate_commission_status: order.affiliate_commission_status || "cancelled",
      payment_status: order.payment_status || null,
      payment_raw_status: order.payment_raw_status || null,
      order_status: order.order_status || null,
      shipping_label_status: order.shipping_label_status || null,
      shipping_tracking_code: order.shipping_tracking_code || null,
      tracking_code: order.tracking_code || null,
      shipped_at: order.shipped_at || null,
      delivered_at: order.delivered_at || null,
      affiliate_order_lifecycle: "cancelled",
      created_at: order.created_at || null,
    }));

  return [...rowsFromConversions, ...tableOnlyRows].sort((a, b) => {
    return new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime();
  });
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

export async function getAffiliateNetwork(affiliateId) {
  const affiliate = await getAffiliateById(affiliateId);

  const [networkRows, applicationRows] = await Promise.all([
    supabaseRequest(
      `/affiliate_network_view?recruiter_affiliate_id=eq.${encodeURIComponent(affiliateId)}&select=*&order=recruited_created_at.desc`
    ),
    supabaseRequest(
      `/affiliate_network_applications_view?recruiter_affiliate_id=eq.${encodeURIComponent(affiliateId)}&select=*&order=created_at.desc`
    ),
  ]);

  const recruited = Array.isArray(networkRows) ? networkRows : [];
  const applications = Array.isArray(applicationRows) ? applicationRows : [];

  const pendingApplications = applications.filter((item) =>
    String(item.status || "").toLowerCase() === "pending"
  );

  const activated = recruited.filter((item) => item.network_status === "activated");

  const summary = {
    recruited_total: recruited.length,
    pending_total: pendingApplications.length,
    active_total: recruited.filter((item) => item.recruited_status === "active").length,
    activated_total: activated.length,
    recruited_total_sales: recruited.reduce((sum, item) => sum + normalizeMoney(item.recruited_total_sales), 0),
    recruited_total_commission: recruited.reduce((sum, item) => sum + normalizeMoney(item.recruited_total_commission), 0),
    recruitment_bonus_total: recruited.reduce((sum, item) => sum + normalizeMoney(item.recruiter_bonus_from_recruited), 0),
  };

  return {
    affiliate,
    summary,
    recruited: recruited.map((item) => ({
      id: item.recruited_affiliate_id,
      full_name: item.recruited_name,
      email: maskEmail(item.recruited_email),
      phone: item.recruited_phone || null,
      ref_code: item.recruited_ref_code,
      coupon_code: item.recruited_coupon_code,
      status: item.recruited_status,
      network_status: item.network_status,
      total_sales: normalizeMoney(item.recruited_total_sales),
      total_commission: normalizeMoney(item.recruited_total_commission),
      total_conversions: Number(item.recruited_total_conversions || 0),
      bonus_from_recruited: normalizeMoney(item.recruiter_bonus_from_recruited),
      created_at: item.recruited_created_at || null,
    })),
    applications: pendingApplications.map((item) => ({
      id: item.application_id,
      full_name: item.full_name,
      email: maskEmail(item.email),
      phone: item.phone || null,
      desired_ref_code: item.desired_ref_code,
      desired_coupon_code: item.desired_coupon_code,
      status: item.status,
      created_at: item.created_at || null,
    })),
  };
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