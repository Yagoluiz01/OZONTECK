import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { env } from "../config/env.js";
import { notifyAffiliatePasswordReset } from "./affiliateNotification.service.js";

const AFFILIATE_TOKEN_EXPIRES_IN = "7d";
const AFFILIATE_PROFILE_PHOTOS_BUCKET =
  process.env.AFFILIATE_PROFILE_PHOTOS_BUCKET || "affiliate-profile-photos";
const AFFILIATE_PROFILE_PHOTO_MAX_BYTES = 3 * 1024 * 1024;
const AFFILIATE_PROFILE_PHOTO_ALLOWED_MIMES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);


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


function sanitizeStorageFileName(name = "foto") {
  const cleanName = String(name || "foto")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9.\-_]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");

  return cleanName || "foto";
}

function getExtensionFromMimeType(mimeType = "") {
  const normalized = String(mimeType || "").toLowerCase();

  if (normalized === "image/png") return "png";
  if (normalized === "image/webp") return "webp";
  if (normalized === "image/gif") return "gif";

  return "jpg";
}

function parseBase64ImagePayload(payload = {}) {
  const mimeType = String(payload.mimeType || payload.mime_type || "")
    .trim()
    .toLowerCase();
  const rawBase64 = String(payload.base64 || payload.file || payload.image || "").trim();

  if (!rawBase64) {
    const error = new Error("Envie uma foto para salvar no perfil da loja.");
    error.statusCode = 400;
    throw error;
  }

  const detectedMime = rawBase64.match(/^data:([^;]+);base64,/)?.[1]?.toLowerCase() || mimeType;
  const cleanBase64 = rawBase64.includes(",") ? rawBase64.split(",").pop() : rawBase64;
  const finalMimeType = detectedMime || "image/jpeg";

  if (!AFFILIATE_PROFILE_PHOTO_ALLOWED_MIMES.has(finalMimeType)) {
    const error = new Error("Formato inválido. Envie JPG, PNG, WEBP ou GIF.");
    error.statusCode = 400;
    throw error;
  }

  const buffer = Buffer.from(cleanBase64, "base64");

  if (!buffer.length) {
    const error = new Error("Foto inválida. Escolha outra imagem.");
    error.statusCode = 400;
    throw error;
  }

  if (buffer.length > AFFILIATE_PROFILE_PHOTO_MAX_BYTES) {
    const error = new Error("Foto muito grande. Envie uma imagem de até 3 MB.");
    error.statusCode = 400;
    throw error;
  }

  return {
    buffer,
    mimeType: finalMimeType,
    originalName: sanitizeStorageFileName(payload.fileName || payload.file_name || "foto-perfil"),
  };
}

async function uploadAffiliateProfilePhoto({ affiliateId, file }) {
  const { buffer, mimeType, originalName } = parseBase64ImagePayload(file);
  const extension = getExtensionFromMimeType(mimeType);
  const nameWithoutExtension = originalName.replace(/\.[a-zA-Z0-9]+$/, "") || "foto-perfil";
  const objectPath = `${encodeURIComponent(affiliateId)}/${Date.now()}-${crypto
    .randomBytes(5)
    .toString("hex")}-${nameWithoutExtension}.${extension}`;

  const uploadResponse = await fetch(
    `${env.supabaseUrl}/storage/v1/object/${AFFILIATE_PROFILE_PHOTOS_BUCKET}/${objectPath}`,
    {
      method: "POST",
      headers: {
        apikey: env.supabaseServiceRoleKey,
        Authorization: `Bearer ${env.supabaseServiceRoleKey}`,
        "Content-Type": mimeType,
        "x-upsert": "false",
      },
      body: buffer,
    }
  );

  const uploadText = await uploadResponse.text();
  let uploadData = null;

  try {
    uploadData = uploadText ? JSON.parse(uploadText) : null;
  } catch {
    uploadData = uploadText;
  }

  if (!uploadResponse.ok) {
    console.error("AFFILIATE PROFILE PHOTO UPLOAD ERROR:", {
      status: uploadResponse.status,
      details: uploadData,
    });

    const error = new Error(
      uploadData?.message ||
        uploadData?.error ||
        "Erro ao enviar foto de perfil. Verifique o bucket affiliate-profile-photos."
    );
    error.statusCode = uploadResponse.status;
    throw error;
  }

  return `${env.supabaseUrl}/storage/v1/object/public/${AFFILIATE_PROFILE_PHOTOS_BUCKET}/${objectPath}`;
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

function hashPasswordResetToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function getAffiliateResetStoreBaseUrl() {
  return (
    process.env.STORE_PUBLIC_URL ||
    process.env.STORE_BASE_URL ||
    process.env.STORE_FRONTEND_URL ||
    process.env.FRONTEND_URL ||
    env.frontendUrl ||
    "https://ozonteck-loja.onrender.com"
  ).replace(/\/+$/, "");
}


async function findAffiliateByEmail(normalizedEmail, selectFields) {
  const email = normalizeEmail(normalizedEmail);

  if (!email) return null;

  const encodedEmail = encodeURIComponent(email);
  const rows = await supabaseRequest(
    `/affiliates?or=(email.eq.${encodedEmail},email.ilike.${encodedEmail})&select=${selectFields}&limit=5`
  );

  const list = Array.isArray(rows) ? rows : [];

  return (
    list.find((item) => normalizeEmail(item?.email) === email) ||
    list[0] ||
    null
  );
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

  if (isOrderDelivered(order)) {
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
    profile_photo_url: affiliate.profile_photo_url || null,
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

  const affiliate = await findAffiliateByEmail(
    normalizedEmail,
    "id,full_name,email,phone,ref_code,coupon_code,status,commission_rate,password_hash,access_enabled,pix_key,pix_key_type,created_at"
  );

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

  const [
    conversions,
    payouts,
    goalRows,
    bonusRows,
    affiliateOrdersTableRows,
    activeLevelRows,
  ] = await Promise.all([
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
    supabaseRequest(
      `/affiliate_levels?is_active=eq.true&select=*&order=level_order.asc`
    ),
  ]);

  const safeConversions = Array.isArray(conversions) ? conversions : [];
  const safePayouts = Array.isArray(payouts) ? payouts : [];
  const safeAffiliateOrdersTableRows = Array.isArray(affiliateOrdersTableRows)
    ? affiliateOrdersTableRows
    : [];
  const safeActiveLevels = Array.isArray(activeLevelRows) ? activeLevelRows : [];
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

      if (lifecycle === "delivered") {
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

  const goalLevelOrder = Number(goal?.current_level_order || 1);
  const currentLevel =
    safeActiveLevels.find((level) => Number(level.level_order || 0) === goalLevelOrder) ||
    safeActiveLevels.find((level) => cleanText(level.name).toLowerCase() === cleanText(goal?.current_level_name).toLowerCase()) ||
    safeActiveLevels[0] ||
    null;
  const currentLevelOrder = Number(currentLevel?.level_order || goalLevelOrder || 1);
  const nextLevel =
    safeActiveLevels.find((level) => Number(level.level_order || 0) > currentLevelOrder) || null;
  const paidConversions = Number(goal?.paid_conversions || 0);
  const currentGoal = Math.max(
    1,
    Number(
      currentLevel?.required_conversions ||
        goal?.current_goal ||
        goal?.required_conversions ||
        3
    )
  );
  const remainingToGoal = Math.max(currentGoal - paidConversions, 0);
  const progressPercent = Math.min(
    Math.max((paidConversions / currentGoal) * 100, 0),
    100
  );

  const level_goal = goal
    ? {
        affiliate_id: goal.affiliate_id,
        current_level_order: currentLevelOrder,
        current_level_name: currentLevel?.name || goal.current_level_name || "Iniciante",
        current_goal: currentGoal,
        paid_conversions: paidConversions,
        progress_percent: progressPercent,
        remaining_to_goal: remainingToGoal,
        current_bonus_amount: normalizeMoney(
          currentLevel?.bonus_amount ?? goal.current_bonus_amount
        ),
        current_bonus_type: currentLevel?.bonus_type || goal.current_bonus_type || "money",
        next_level_order: nextLevel?.level_order || goal.next_level_order || null,
        next_level_name: nextLevel?.name || goal.next_level_name || null,
        pending_bonus_amount: normalizeMoney(goal.pending_bonus_amount),
        paid_bonus_amount: normalizeMoney(goal.paid_bonus_amount),
        total_bonus_amount: normalizeMoney(goal.total_bonus_amount),
      }
    : {
        affiliate_id: affiliateId,
        current_level_order: currentLevelOrder,
        current_level_name: currentLevel?.name || "Iniciante",
        current_goal: currentGoal,
        paid_conversions: 0,
        progress_percent: 0,
        remaining_to_goal: currentGoal,
        current_bonus_amount: normalizeMoney(currentLevel?.bonus_amount ?? 20),
        current_bonus_type: currentLevel?.bonus_type || "money",
        next_level_order: nextLevel?.level_order || null,
        next_level_name: nextLevel?.name || null,
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

  const levels = safeActiveLevels.map((level) => ({
    id: level.id,
    level_order: Number(level.level_order || 0),
    name: level.name || level.level_name || "Nível",
    required_conversions: Math.max(
      1,
      Number(level.required_conversions || level.goal_sales_quantity || 1)
    ),
    bonus_amount: normalizeMoney(level.bonus_amount),
    bonus_type: level.bonus_type || "money",
    badge_color: level.badge_color || "#16d45d",
    description: level.description || null,
    is_active: level.is_active !== false,
  }));

  return {
    affiliate,
    summary,
    level_goal,
    level_bonuses,
    levels,
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


const STORE_BASE_URL = String(
  // IMPORTANTE: não usar FRONTEND_URL aqui.
  // Em alguns ambientes ela aponta para o Admin/Vite (localhost:5173),
  // o que gera links quebrados para os afiliados compartilharem.
  process.env.STORE_BASE_URL || "https://ozonteck-loja.onrender.com"
).replace(/\/+$/, "");

function roundMoney(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? Number(number.toFixed(2)) : 0;
}

function buildProductAffiliateLink(refCode, productId) {
  const params = new URLSearchParams();

  if (productId) {
    params.set("id", productId);
  }

  if (refCode) {
    params.set("ref", refCode);
  }

  return `${STORE_BASE_URL}/pages-html/detalhe-produto.html?${params.toString()}`;
}

function getProductPrice(product = {}) {
  return roundMoney(product.price ?? product.current_price ?? 0);
}

function isProductPublic(product = {}) {
  const status = normalizeStatus(product.status || "active");

  if (!status) {
    return true;
  }

  return ["active", "ativo", "published", "publicado", "available", "disponivel"].includes(status);
}

async function getOrderItemsByOrderIds(orderIds = []) {
  const ids = Array.from(
    new Set(
      (orderIds || [])
        .map((id) => String(id || "").trim())
        .filter(Boolean)
    )
  );

  if (!ids.length) {
    return [];
  }

  const chunkSize = 80;
  const items = [];

  for (let index = 0; index < ids.length; index += chunkSize) {
    const chunk = ids.slice(index, index + chunkSize);
    const rows = await supabaseRequest(
      `/order_items?order_id=in.(${chunk.join(",")})&select=order_id,product_id,quantity`
    );

    if (Array.isArray(rows)) {
      items.push(...rows);
    }
  }

  return items;
}

function getOrderGoalDate(order = {}) {
  return order.created_at || order.delivered_at || null;
}

function getConfirmedProductUnits({ target, productId, orderItems = [], orderMap = new Map() }) {
  if (!target || !productId) return 0;

  const appliedAt = target.applied_at ? new Date(target.applied_at).getTime() : 0;

  return orderItems.reduce((total, item) => {
    if (String(item?.product_id || "") !== String(productId)) {
      return total;
    }

    const order = orderMap.get(String(item?.order_id || ""));

    if (!order || !isOrderDelivered(order) || isOrderCancelled(order)) {
      return total;
    }

    const goalDate = getOrderGoalDate(order);
    const goalTimestamp = goalDate ? new Date(goalDate).getTime() : 0;

    if (appliedAt && (!goalTimestamp || goalTimestamp < appliedAt)) {
      return total;
    }

    const quantity = Math.max(0, Math.trunc(Number(item?.quantity || 0)));
    return total + quantity;
  }, 0);
}

async function getAffiliateProductGoalContext(affiliateId) {
  const [goalRows, activeLevels, conversions, directOrders] = await Promise.all([
    supabaseRequest(
      `/affiliate_goal_overview?affiliate_id=eq.${encodeURIComponent(affiliateId)}&select=*&limit=1`
    ),
    supabaseRequest(
      `/affiliate_levels?is_active=eq.true&select=id,level_order,name,required_conversions,bonus_amount,bonus_type&order=level_order.asc`
    ),
    supabaseRequest(
      `/affiliate_conversions?affiliate_id=eq.${encodeURIComponent(affiliateId)}&conversion_type=eq.sale_commission&select=order_id,status&order=created_at.desc&limit=500`
    ),
    getAffiliateOrdersTableRows(affiliateId, { limit: 500 }),
  ]);

  const goal = Array.isArray(goalRows) ? goalRows[0] || null : null;
  const levels = Array.isArray(activeLevels) ? activeLevels : [];
  const currentLevelOrder = Math.max(1, Number(goal?.current_level_order || 1));
  const currentLevel =
    levels.find((level) => Number(level?.level_order || 0) === currentLevelOrder) ||
    levels.find(
      (level) =>
        normalizeStatus(level?.name) === normalizeStatus(goal?.current_level_name)
    ) ||
    levels[0] ||
    null;

  if (!currentLevel?.id) {
    return {
      currentLevel: null,
      targetsByProduct: new Map(),
      orderItems: [],
      orderMap: new Map(),
    };
  }

  const targets = await supabaseRequest(
    `/affiliate_product_goal_targets?affiliate_level_id=eq.${encodeURIComponent(
      currentLevel.id
    )}&is_active=eq.true&select=id,product_id,affiliate_level_id,required_units,global_required_conversions_snapshot,accumulated_bonus_amount,safe_contribution_per_unit,reference_price,protected_margin_percent,safety_reserve_percent,applied_at,updated_at`
  );

  const conversionOrderIds = (Array.isArray(conversions) ? conversions : [])
    .filter((conversion) => !isCancelledLikeStatus(conversion?.status))
    .map((conversion) => conversion?.order_id);

  const directOrderRows = Array.isArray(directOrders) ? directOrders : [];
  const extraOrders = await getOrdersByIds(conversionOrderIds);
  const orderMap = buildOrderMap([...directOrderRows, ...extraOrders]);
  const deliveredOrderIds = Array.from(orderMap.values())
    .filter((order) => isOrderDelivered(order) && !isOrderCancelled(order))
    .map((order) => order.id);
  const orderItems = await getOrderItemsByOrderIds(deliveredOrderIds);

  return {
    currentLevel,
    targetsByProduct: new Map(
      (Array.isArray(targets) ? targets : []).map((target) => [
        String(target?.product_id || ""),
        target,
      ])
    ),
    orderItems,
    orderMap,
  };
}

function normalizeAffiliateProduct(row = {}, affiliate = {}, goalContext = {}) {
  const product = row.products || {};
  const productId = String(row.product_id || product.id || "").trim();
  const price = getProductPrice(product);
  const defaultPercent = roundMoney(row.affiliate_commission_percent ?? affiliate.commission_rate ?? 0);
  const specialPercent = roundMoney(row.special_affiliate_commission_percent ?? 0);
  const hasSpecialCommission = Boolean(affiliate.special_product_commission_enabled);
  const commissionPercent = hasSpecialCommission && specialPercent > 0 ? specialPercent : defaultPercent;
  const estimatedCommission = roundMoney(price * (commissionPercent / 100));
  const safeStatus = normalizeStatus(row.status || "pending");
  const isSafePricing = ["healthy", "saudavel"].includes(safeStatus);
  const target = goalContext?.targetsByProduct?.get(String(productId)) || null;
  const confirmedUnits = target
    ? getConfirmedProductUnits({
        target,
        productId,
        orderItems: goalContext.orderItems || [],
        orderMap: goalContext.orderMap || new Map(),
      })
    : 0;
  const requiredUnits = target
    ? Math.max(1, Math.trunc(Number(target.required_units || 1)))
    : 0;
  const remainingUnits = target ? Math.max(requiredUnits - confirmedUnits, 0) : 0;
  const progressPercent = target
    ? Math.min(Math.max((confirmedUnits / requiredUnits) * 100, 0), 100)
    : 0;

  return {
    id: productId,
    product_id: productId,
    name: product.name || "Produto",
    sku: product.sku || null,
    category: product.category || null,
    image_url: product.image_url || product.imageUrl || "",
    image_url_2: product.image_url_2 || product.imageUrl2 || "",
    short_description: product.short_description || "",
    price,
    current_price: price,
    commission_percent: commissionPercent,
    affiliate_commission_percent: commissionPercent,
    commission_type: hasSpecialCommission && specialPercent > 0 ? "special" : "default",
    special_product_commission_enabled: hasSpecialCommission,
    estimated_commission: estimatedCommission,
    estimated_default_commission: estimatedCommission,
    pricing_status: row.status || "pending",
    risk_message: row.risk_message || null,
    can_promote: isSafePricing && price > 0 && commissionPercent > 0,
    affiliate_link: buildProductAffiliateLink(affiliate.ref_code, productId),
    product_goal: target
      ? {
          is_product_specific: true,
          level_id: goalContext?.currentLevel?.id || target.affiliate_level_id || null,
          level_order: Number(goalContext?.currentLevel?.level_order || 0),
          level_name: goalContext?.currentLevel?.name || "Nível atual",
          required_units: requiredUnits,
          confirmed_units: confirmedUnits,
          remaining_units: remainingUnits,
          progress_percent: Number(progressPercent.toFixed(2)),
          bonus_amount: roundMoney(target.accumulated_bonus_amount),
          safe_contribution_per_unit: roundMoney(target.safe_contribution_per_unit),
          reference_price: roundMoney(target.reference_price),
          protected_margin_percent: roundMoney(target.protected_margin_percent),
          safety_reserve_percent: roundMoney(target.safety_reserve_percent),
          applied_at: target.applied_at || null,
          updated_at: target.updated_at || null,
          counts_only_delivered_units: true,
        }
      : null,
  };
}

export async function getAffiliatePromotionalProducts(affiliateId) {
  const affiliate = await getAffiliateById(affiliateId);
  const goalContext = await getAffiliateProductGoalContext(affiliateId);

  const rows = await supabaseRequest(
    `/product_pricing?select=id,product_id,affiliate_commission_percent,special_affiliate_commission_percent,status,risk_message,updated_at,products(id,name,sku,price,category,status,image_url,image_url_2,short_description)&order=updated_at.desc&limit=200`
  );

  const safeRows = Array.isArray(rows) ? rows : [];

  const products = safeRows
    .filter((row) => row?.products && isProductPublic(row.products))
    .map((row) => normalizeAffiliateProduct(row, affiliate, goalContext))
    .filter((product) => product.product_id && product.price > 0)
    .sort((a, b) => {
      if (a.can_promote !== b.can_promote) {
        return a.can_promote ? -1 : 1;
      }

      return b.estimated_commission - a.estimated_commission;
    });

  return {
    affiliate,
    products,
  };
}

async function getAffiliateStorefrontPhotoMap(affiliateIds = []) {
  const ids = [...new Set((affiliateIds || []).filter(Boolean))];

  if (!ids.length) {
    return new Map();
  }

  const encodedIds = ids
    .map((id) => `"${String(id).replace(/"/g, '\\"')}"`)
    .join(",");

  try {
    const rows = await supabaseRequest(
      `/affiliate_storefronts?affiliate_id=in.(${encodedIds})&select=affiliate_id,profile_photo_url`
    );

    return new Map(
      (Array.isArray(rows) ? rows : [])
        .filter((item) => item.profile_photo_url)
        .map((item) => [item.affiliate_id, item.profile_photo_url])
    );
  } catch (error) {
    console.error("AFFILIATE NETWORK PHOTO MAP ERROR:", {
      affiliateIds: ids,
      message: error?.message,
      details: error?.details,
    });

    return new Map();
  }
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
  const networkPhotoMap = await getAffiliateStorefrontPhotoMap([
    affiliateId,
    ...recruited.map((item) => item.recruited_affiliate_id).filter(Boolean),
  ]);

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
    affiliate: {
      ...affiliate,
      profile_photo_url: networkPhotoMap.get(affiliate.id) || affiliate.profile_photo_url || null,
    },
    summary,
    recruited: recruited.map((item) => ({
      id: item.recruited_affiliate_id,
      full_name: item.recruited_name,
      email: maskEmail(item.recruited_email),
      phone: item.recruited_phone || null,
      ref_code: item.recruited_ref_code,
      coupon_code: item.recruited_coupon_code,
      profile_photo_url:
        item.recruited_profile_photo_url ||
        item.profile_photo_url ||
        networkPhotoMap.get(item.recruited_affiliate_id) ||
        null,
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


function normalizeSlug(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function buildAffiliateStorefrontSlug(affiliate = {}) {
  const base = normalizeSlug(affiliate.ref_code || affiliate.full_name || affiliate.email);
  const suffix = String(affiliate.id || "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 8);

  return normalizeSlug(["loja", base || "afiliado", suffix].filter(Boolean).join("-"));
}

function buildAffiliateStorefrontUrl(storefront = {}, affiliate = {}) {
  const params = new URLSearchParams();

  if (storefront.slug) {
    params.set("loja", storefront.slug);
  }

  if (affiliate.ref_code) {
    params.set("ref", affiliate.ref_code);
  }

  return `${STORE_BASE_URL}/pages-html/minha-loja.html?${params.toString()}`;
}

function normalizeStorefront(row = {}, affiliate = {}) {
  return {
    id: row.id,
    affiliate_id: row.affiliate_id,
    slug: row.slug,
    title: row.title || `Loja de ${affiliate.full_name || "Afiliado OZONTECK"}`,
    description:
      row.description ||
      "Produtos selecionados por um afiliado OZONTECK para facilitar sua escolha.",
    banner_url: row.banner_url || null,
    profile_photo_url: row.profile_photo_url || null,
    is_active: row.is_active !== false,
    public_url: buildAffiliateStorefrontUrl(row, affiliate),
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

async function findAffiliateStorefrontByAffiliateId(affiliateId) {
  const rows = await supabaseRequest(
    `/affiliate_storefronts?affiliate_id=eq.${encodeURIComponent(
      affiliateId
    )}&select=id,affiliate_id,slug,title,description,banner_url,profile_photo_url,is_active,created_at,updated_at&limit=1`
  );

  return Array.isArray(rows) ? rows[0] || null : null;
}

async function getOrCreateAffiliateStorefront(affiliate) {
  const existing = await findAffiliateStorefrontByAffiliateId(affiliate.id);

  if (existing) {
    return existing;
  }

  const slug = buildAffiliateStorefrontSlug(affiliate);
  const payload = {
    affiliate_id: affiliate.id,
    slug,
    title: `Loja de ${affiliate.full_name || "Afiliado OZONTECK"}`,
    description:
      "Produtos selecionados por um afiliado OZONTECK para facilitar sua escolha.",
    is_active: true,
    updated_at: new Date().toISOString(),
  };

  const created = await supabaseRequest("/affiliate_storefronts", {
    method: "POST",
    body: payload,
  });

  const row = Array.isArray(created) ? created[0] : null;

  if (!row?.id) {
    const error = new Error("Não foi possível criar a loja do afiliado.");
    error.statusCode = 500;
    throw error;
  }

  return row;
}

async function getAffiliateStorefrontItems(storefrontId) {
  const rows = await supabaseRequest(
    `/affiliate_storefront_items?storefront_id=eq.${encodeURIComponent(
      storefrontId
    )}&select=id,storefront_id,product_id,position,custom_note,created_at&order=position.asc&order=created_at.asc`
  );

  return Array.isArray(rows) ? rows : [];
}

function sortStorefrontProductsByItems(products = [], items = []) {
  const positionMap = new Map(
    items.map((item, index) => [
      String(item.product_id || ""),
      Number.isFinite(Number(item.position)) ? Number(item.position) : index,
    ])
  );

  return [...products].sort((a, b) => {
    const positionA = positionMap.get(String(a.product_id || a.id || "")) ?? 999999;
    const positionB = positionMap.get(String(b.product_id || b.id || "")) ?? 999999;

    if (positionA !== positionB) {
      return positionA - positionB;
    }

    return String(a.name || "").localeCompare(String(b.name || ""), "pt-BR");
  });
}

function buildStorefrontPayload({ affiliate, storefront, items, products }) {
  const selectedIds = new Set(items.map((item) => String(item.product_id || "")));
  const selectedProducts = sortStorefrontProductsByItems(
    products.filter((product) => selectedIds.has(String(product.product_id || product.id || ""))),
    items
  );

  return {
    affiliate,
    storefront: normalizeStorefront(storefront, affiliate),
    selected_product_ids: Array.from(selectedIds),
    selected_products: selectedProducts,
    available_products: products.map((product) => ({
      ...product,
      selected: selectedIds.has(String(product.product_id || product.id || "")),
    })),
  };
}

export async function getAffiliateStorefront(affiliateId) {
  const result = await getAffiliatePromotionalProducts(affiliateId);
  const storefront = await getOrCreateAffiliateStorefront(result.affiliate);
  const items = await getAffiliateStorefrontItems(storefront.id);

  return buildStorefrontPayload({
    affiliate: result.affiliate,
    storefront,
    items,
    products: result.products,
  });
}

export async function addAffiliateStorefrontItem(affiliateId, payload = {}) {
  const productId = String(payload.product_id || payload.productId || "").trim();

  if (!productId) {
    const error = new Error("Informe o produto para adicionar à loja.");
    error.statusCode = 400;
    throw error;
  }

  const result = await getAffiliatePromotionalProducts(affiliateId);
  const product = result.products.find((item) => String(item.product_id) === productId);

  if (!product) {
    const error = new Error("Produto não encontrado ou indisponível para divulgação.");
    error.statusCode = 404;
    throw error;
  }

  if (!product.can_promote) {
    const error = new Error("Este produto ainda não está seguro para divulgação pelo afiliado.");
    error.statusCode = 409;
    throw error;
  }

  const storefront = await getOrCreateAffiliateStorefront(result.affiliate);
  const items = await getAffiliateStorefrontItems(storefront.id);
  const alreadySelected = items.some((item) => String(item.product_id) === productId);

  if (!alreadySelected) {
    const nextPosition = items.reduce((max, item) => {
      const position = Number(item.position || 0);
      return Number.isFinite(position) && position > max ? position : max;
    }, -1) + 1;

    await supabaseRequest("/affiliate_storefront_items", {
      method: "POST",
      body: {
        storefront_id: storefront.id,
        product_id: productId,
        position: nextPosition,
        custom_note: String(payload.custom_note || payload.customNote || "").trim() || null,
      },
    });

    await supabaseRequest(`/affiliate_storefronts?id=eq.${encodeURIComponent(storefront.id)}`, {
      method: "PATCH",
      body: {
        updated_at: new Date().toISOString(),
      },
    });
  }

  return getAffiliateStorefront(affiliateId);
}

export async function removeAffiliateStorefrontItem(affiliateId, productId) {
  const cleanProductId = String(productId || "").trim();

  if (!cleanProductId) {
    const error = new Error("Informe o produto para remover da loja.");
    error.statusCode = 400;
    throw error;
  }

  const affiliate = await getAffiliateById(affiliateId);
  const storefront = await getOrCreateAffiliateStorefront(affiliate);

  await supabaseRequest(
    `/affiliate_storefront_items?storefront_id=eq.${encodeURIComponent(
      storefront.id
    )}&product_id=eq.${encodeURIComponent(cleanProductId)}`,
    {
      method: "DELETE",
      headers: {
        Prefer: "return=minimal",
      },
    }
  );

  await supabaseRequest(`/affiliate_storefronts?id=eq.${encodeURIComponent(storefront.id)}`, {
    method: "PATCH",
    body: {
      updated_at: new Date().toISOString(),
    },
  });

  return getAffiliateStorefront(affiliateId);
}


export async function updateAffiliateStorefrontProfilePhoto(affiliateId, payload = {}) {
  const affiliate = await getAffiliateById(affiliateId);
  const storefront = await getOrCreateAffiliateStorefront(affiliate);
  let profilePhotoUrl = null;

  if (payload.remove === true || payload.remove_photo === true) {
    profilePhotoUrl = null;
  } else if (payload.profile_photo_url || payload.profilePhotoUrl) {
    const directUrl = String(payload.profile_photo_url || payload.profilePhotoUrl || "").trim();

    if (!/^https?:\/\//i.test(directUrl)) {
      const error = new Error("URL da foto inválida.");
      error.statusCode = 400;
      throw error;
    }

    profilePhotoUrl = directUrl;
  } else {
    profilePhotoUrl = await uploadAffiliateProfilePhoto({
      affiliateId,
      file: payload,
    });
  }

  const updated = await supabaseRequest(
    `/affiliate_storefronts?id=eq.${encodeURIComponent(storefront.id)}`,
    {
      method: "PATCH",
      body: {
        profile_photo_url: profilePhotoUrl,
        updated_at: new Date().toISOString(),
      },
    }
  );

  const updatedStorefront = Array.isArray(updated) ? updated[0] || storefront : storefront;

  return {
    affiliate,
    storefront: normalizeStorefront(
      {
        ...storefront,
        ...updatedStorefront,
        profile_photo_url: profilePhotoUrl,
      },
      affiliate
    ),
  };
}


export async function getPublicAffiliateStorefront(slug) {
  const cleanSlug = normalizeSlug(slug);

  if (!cleanSlug) {
    const error = new Error("Loja do afiliado não informada.");
    error.statusCode = 400;
    throw error;
  }

  const storefrontRows = await supabaseRequest(
    `/affiliate_storefronts?slug=eq.${encodeURIComponent(
      cleanSlug
    )}&is_active=eq.true&select=id,affiliate_id,slug,title,description,banner_url,profile_photo_url,is_active,created_at,updated_at&limit=1`
  );

  const storefront = Array.isArray(storefrontRows) ? storefrontRows[0] : null;

  if (!storefront?.id) {
    const error = new Error("Loja do afiliado não encontrada.");
    error.statusCode = 404;
    throw error;
  }

  const affiliate = await getAffiliateById(storefront.affiliate_id);
  const items = await getAffiliateStorefrontItems(storefront.id);
  const selectedIds = items.map((item) => String(item.product_id || "")).filter(Boolean);

  if (!selectedIds.length) {
    return {
      affiliate: {
        id: affiliate.id,
        full_name: affiliate.full_name,
        ref_code: affiliate.ref_code,
        coupon_code: affiliate.coupon_code || null,
        profile_photo_url: storefront.profile_photo_url || null,
      },
      storefront: normalizeStorefront(storefront, affiliate),
      products: [],
    };
  }

  const rows = await supabaseRequest(
    `/product_pricing?product_id=in.(${selectedIds.join(",")})&select=id,product_id,affiliate_commission_percent,special_affiliate_commission_percent,status,risk_message,updated_at,products(id,name,sku,price,category,status,image_url,image_url_2,short_description)&limit=200`
  );

  const products = (Array.isArray(rows) ? rows : [])
    .filter((row) => row?.products && isProductPublic(row.products))
    .map((row) => normalizeAffiliateProduct(row, affiliate))
    .filter((product) => product.product_id && product.price > 0 && product.can_promote);

  return {
    affiliate: {
      id: affiliate.id,
      full_name: affiliate.full_name,
      ref_code: affiliate.ref_code,
      coupon_code: affiliate.coupon_code || null,
      profile_photo_url: storefront.profile_photo_url || null,
    },
    storefront: normalizeStorefront(storefront, affiliate),
    products: sortStorefrontProductsByItems(products, items),
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

  const affiliate = await findAffiliateByEmail(
    normalizedEmail,
    "id,full_name,email,phone,ref_code,coupon_code,status,commission_rate,password_hash,access_enabled,pix_key,pix_key_type,created_at"
  );

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

  const rawToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = hashPasswordResetToken(rawToken);
  const expiresInMinutes = 30;
  const expiresAt = new Date(Date.now() + expiresInMinutes * 60 * 1000).toISOString();
  const now = new Date().toISOString();

  await supabaseRequest(
    `/affiliate_password_resets?affiliate_id=eq.${encodeURIComponent(
      affiliate.id
    )}&used_at=is.null`,
    {
      method: "PATCH",
      body: {
        used_at: now,
      },
    }
  );

  await supabaseRequest("/affiliate_password_resets", {
    method: "POST",
    body: {
      affiliate_id: affiliate.id,
      email: normalizedEmail,
      token_hash: tokenHash,
      expires_at: expiresAt,
    },
  });

  const resetLink = `${getAffiliateResetStoreBaseUrl()}/pages-html/afiliado-redefinir-senha.html?token=${rawToken}`;

  const notification = await notifyAffiliatePasswordReset(affiliate, {
    resetLink,
    expiresInMinutes,
  });

  if (!notification?.sent) {
    const error = new Error(
      "Não foi possível enviar o link de redefinição pelo Brevo. Verifique as variáveis SMTP no Render."
    );
    error.statusCode = 502;
    error.details = notification;
    throw error;
  }

  return {
    sent: true,
    skipped: false,
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

  const affiliate = await findAffiliateByEmail(
    normalizedEmail,
    "id,full_name,email,status,access_enabled,password_hash,ref_code"
  );

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