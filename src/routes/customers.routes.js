// customers.routes.js
import express from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";

const router = express.Router();

function onlyDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizePhone(value) {
  const digits = onlyDigits(value);

  if (!digits) {
    return "";
  }

  if (digits.startsWith("55") && digits.length >= 12) {
    return digits;
  }

  if (digits.length >= 10 && digits.length <= 11) {
    return `55${digits}`;
  }

  return digits;
}

function toNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function isPaidOrder(order) {
  const paymentStatus = String(order?.payment_status || "").trim().toLowerCase();
  const paidAt = String(order?.paid_at || "").trim();

  return ["paid", "approved"].includes(paymentStatus) && Boolean(paidAt);
}

function buildWhatsappUrl(phone, message) {
  const normalizedPhone = normalizePhone(phone);

  if (!normalizedPhone || !message) {
    return "";
  }

  return `https://wa.me/${normalizedPhone}?text=${encodeURIComponent(message)}`;
}

async function getUserFromToken(token) {
  const response = await fetch(`${env.supabaseUrl}/auth/v1/user`, {
    method: "GET",
    headers: {
      apikey: env.supabaseAnonKey,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });

  const data = await response.json().catch(() => null);

  return {
    ok: response.ok,
    status: response.status,
    data,
  };
}

async function findAdminByEmail(email) {
  const response = await fetch(`${env.supabaseUrl}/rest/v1/rpc/get_admin_by_email`, {
    method: "POST",
    headers: {
      apikey: env.supabaseServiceRoleKey,
      Authorization: `Bearer ${env.supabaseServiceRoleKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      p_email: email,
    }),
  });

  const data = await response.json().catch(() => null);

  return {
    ok: response.ok,
    status: response.status,
    data,
  };
}

async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        message: "Token não enviado",
      });
    }

    const appToken = authHeader.split(" ")[1];
    const decoded = jwt.verify(appToken, env.jwtSecret);

    if (!decoded.supabase_access_token) {
      return res.status(401).json({
        success: false,
        message: "Sessão inválida",
      });
    }

    const userResponse = await getUserFromToken(decoded.supabase_access_token);

    if (!userResponse.ok || !userResponse.data?.email) {
      return res.status(401).json({
        success: false,
        message: "Sessão expirada ou inválida",
      });
    }

    const normalizedEmail = String(userResponse.data.email).trim().toLowerCase();
    const adminResponse = await findAdminByEmail(normalizedEmail);

    const admin = Array.isArray(adminResponse.data)
      ? adminResponse.data[0]
      : adminResponse.data;

    if (!adminResponse.ok || !admin) {
      return res.status(403).json({
        success: false,
        message: "Usuário sem acesso ao painel",
      });
    }

    if (!admin.is_active) {
      return res.status(403).json({
        success: false,
        message: "Usuário inativo",
      });
    }

    req.auth = {
      admin,
      appToken,
      supabaseAccessToken: decoded.supabase_access_token,
    };

    next();
  } catch {
    return res.status(401).json({
      success: false,
      message: "Token inválido ou expirado",
    });
  }
}

async function callRpc(name, body = {}) {
  const response = await fetch(`${env.supabaseUrl}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: env.supabaseServiceRoleKey,
      Authorization: `Bearer ${env.supabaseServiceRoleKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = await response.json().catch(() => []);

  return {
    ok: response.ok,
    status: response.status,
    data,
  };
}

async function fetchActivationOffers() {
  const url = new URL(`${env.supabaseUrl}/rest/v1/customer_activation_offers`);

  url.searchParams.set(
    "select",
    "id,order_id,order_number,customer_name,customer_email,customer_phone,total_amount,offer_type,offer_status,message_status,whatsapp_message,whatsapp_url,paid_at,sent_at,accepted_at,rejected_at,notes,created_at,updated_at"
  );
  url.searchParams.set("order", "created_at.desc");
  url.searchParams.set("limit", "1000");

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      apikey: env.supabaseServiceRoleKey,
      Authorization: `Bearer ${env.supabaseServiceRoleKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
  });

  const data = await response.json().catch(() => []);

  if (!response.ok || !Array.isArray(data)) {
    console.error("ERRO AO BUSCAR CONDIÇÕES DE ATIVAÇÃO:", data);
    return [];
  }

  return data;
}

async function fetchOrdersForCustomerStats() {
  const url = new URL(`${env.supabaseUrl}/rest/v1/orders`);

  url.searchParams.set(
    "select",
    "id,order_number,customer_name,customer_email,customer_phone,total_amount,subtotal,payment_status,order_status,paid_at,created_at"
  );
  url.searchParams.set("order", "created_at.desc");
  url.searchParams.set("limit", "5000");

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      apikey: env.supabaseServiceRoleKey,
      Authorization: `Bearer ${env.supabaseServiceRoleKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
  });

  const data = await response.json().catch(() => []);

  if (!response.ok || !Array.isArray(data)) {
    console.error("ERRO AO BUSCAR PEDIDOS PARA CLIENTES:", data);
    return [];
  }

  return data;
}

function filterValidActivationOffers(offers = [], orders = []) {
  const validPaidOrderIds = new Set(
    orders
      .filter((order) => {
        const subtotal = Number(order.subtotal || 0);

        return (
          order?.id &&
          isPaidOrder(order) &&
          subtotal >= 150
        );
      })
      .map((order) => String(order.id))
  );

  return offers.filter((offer) =>
    validPaidOrderIds.has(String(offer.order_id || ""))
  );
}

function findOrdersForCustomer(customer, orders = []) {
  const customerEmail = normalizeEmail(customer.email);
  const customerPhone = normalizePhone(customer.phone);

  if (!customerEmail && !customerPhone) {
    return [];
  }

  return orders.filter((order) => {
    const orderEmail = normalizeEmail(order.customer_email);
    const orderPhone = normalizePhone(order.customer_phone);

    if (customerEmail && orderEmail && customerEmail === orderEmail) {
      return true;
    }

    if (customerPhone && orderPhone && customerPhone === orderPhone) {
      return true;
    }

    return false;
  });
}

function buildOrderStats(customer, orders = []) {
  const customerOrders = findOrdersForCustomer(customer, orders).filter(isPaidOrder);

  if (!customerOrders.length) {
    return {
      totalOrders: 0,
      totalSpent: 0,
      lastPurchaseAt: null,
    };
  }

  const totalSpent = customerOrders.reduce(
    (sum, order) => sum + toNumber(order.total_amount, 0),
    0
  );

  const lastPurchaseAt = customerOrders
    .map((order) => order.paid_at || order.created_at)
    .filter(Boolean)
    .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0];

  return {
    totalOrders: customerOrders.length,
    totalSpent,
    lastPurchaseAt,
  };
}

function getActivationLabel(offerStatus) {
  const status = String(offerStatus || "").trim().toLowerCase();

  const labels = {
    recruit_for_activation: "Recrutar para ativação",
    contacted: "Mensagem enviada",
    accepted: "Aceitou ativação",
    rejected: "Recusou",
    expired: "Expirada",
  };

  return labels[status] || "-";
}

function normalizeMessageStatus(value) {
  const status = String(value || "").trim().toLowerCase();

  const map = {
    pendente: "pending",
    pending: "pending",
    enviada: "sent",
    enviado: "sent",
    sent: "sent",
    failed: "failed",
    falhou: "failed",
  };

  return map[status] || status;
}

function mapActivationOffer(offer, preferredPhone = "") {
  if (!offer?.id) {
    return null;
  }

  const whatsappMessage = offer.whatsapp_message || "";
  const phoneForWhatsapp = preferredPhone || offer.customer_phone || "";
  const safeWhatsappUrl = buildWhatsappUrl(phoneForWhatsapp, whatsappMessage);

  return {
    id: offer.id,
    orderId: offer.order_id || "",
    orderNumber: offer.order_number || "",
    customerName: offer.customer_name || "",
    customerEmail: offer.customer_email || "",
    customerPhone: phoneForWhatsapp,
    totalAmount: Number(offer.total_amount || 0),
    offerType: offer.offer_type || "mlm_activation",
    offerStatus: offer.offer_status || "",
    messageStatus: normalizeMessageStatus(offer.message_status),
    statusLabel: getActivationLabel(offer.offer_status),
    whatsappMessage,
    whatsappUrl: safeWhatsappUrl,
    paidAt: offer.paid_at || null,
    sentAt: offer.sent_at || null,
    acceptedAt: offer.accepted_at || null,
    rejectedAt: offer.rejected_at || null,
    notes: offer.notes || "",
    createdAt: offer.created_at || null,
    updatedAt: offer.updated_at || null,
  };
}

function findActivationOfferForCustomer(customer, offers = []) {
  const customerEmail = normalizeEmail(customer.email || customer.full_name_email);
  const customerPhone = normalizePhone(customer.phone);

  if (!customerEmail && !customerPhone) {
    return null;
  }

  const matched = offers.find((offer) => {
    const offerEmail = normalizeEmail(offer.customer_email);
    const offerPhone = normalizePhone(offer.customer_phone);

    if (customerEmail && offerEmail && customerEmail === offerEmail) {
      return true;
    }

    if (customerPhone && offerPhone && customerPhone === offerPhone) {
      return true;
    }

    return false;
  });

  return mapActivationOffer(matched, customer.phone);
}

function formatDate(value) {
  if (!value) return "-";

  try {
    return new Date(value).toLocaleDateString("pt-BR");
  } catch {
    return value;
  }
}

function mapCustomer(customer, activationOffer = null, orderStats = null) {
  const calculatedOrders = Number(orderStats?.totalOrders || 0);
  const calculatedSpent = Number(orderStats?.totalSpent || 0);
  const calculatedLastPurchaseAt = orderStats?.lastPurchaseAt || null;

  const rpcOrders = Number(customer.total_orders || 0);
  const rpcSpent = Number(customer.total_spent || 0);

  return {
    id: customer.id,
    name: customer.full_name,
    email: customer.email,
    phone: customer.phone || "",
    city: customer.city
      ? `${customer.city}${customer.state ? ` - ${customer.state}` : ""}`
      : "-",
    state: customer.state || "",
    origin: customer.origin || "Site",
    status: customer.status || "lead",
    notes: customer.notes || "",

    totalOrders: calculatedOrders || rpcOrders,
    totalSpent: calculatedSpent || rpcSpent,
    lastPurchase: formatDate(calculatedLastPurchaseAt || customer.last_purchase_at),

    activationOffer,
    activationStatus: activationOffer?.offerStatus || "",
    activationStatusLabel: activationOffer?.statusLabel || "-",
  };
}

router.get("/", requireAuth, async (req, res) => {
  try {
    const search = String(req.query.search || "").trim().toLowerCase();
    const status = String(req.query.status || "all").trim().toLowerCase();
    const origin = String(req.query.origin || "all").trim().toLowerCase();

    const response = await callRpc("get_customers", {});

    if (!response.ok) {
      return res.status(500).json({
        success: false,
        message: "Erro ao buscar clientes",
        details: response.data,
      });
    }

    let customers = Array.isArray(response.data) ? response.data : [];

    const orders = await fetchOrdersForCustomerStats();

    let activationOffers = await fetchActivationOffers();
    activationOffers = filterValidActivationOffers(activationOffers, orders);

    if (search) {
      customers = customers.filter((customer) => {
        const fullName = String(customer.full_name || "").toLowerCase();
        const email = String(customer.email || "").toLowerCase();
        const phone = String(customer.phone || "").toLowerCase();

        return (
          fullName.includes(search) ||
          email.includes(search) ||
          phone.includes(search)
        );
      });
    }

    if (status !== "all") {
      customers = customers.filter(
        (customer) => String(customer.status || "").toLowerCase() === status
      );
    }

    if (origin !== "all") {
      customers = customers.filter(
        (customer) => String(customer.origin || "").toLowerCase() === origin
      );
    }

    return res.status(200).json({
      success: true,
      customers: customers.map((customer) => {
        const activationOffer = findActivationOfferForCustomer(
          customer,
          activationOffers
        );

        const orderStats = buildOrderStats(customer, orders);

        return mapCustomer(customer, activationOffer, orderStats);
      }),
    });
  } catch (error) {
    console.error("ERRO AO LISTAR CLIENTES:", error);

    return res.status(500).json({
      success: false,
      message: "Erro interno ao listar clientes",
    });
  }
});

router.get("/:id", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const response = await callRpc("get_customer_by_id", {
      p_id: id,
    });

    if (!response.ok) {
      return res.status(500).json({
        success: false,
        message: "Erro ao buscar cliente",
        details: response.data,
      });
    }

    const customer = Array.isArray(response.data) ? response.data[0] : null;

    if (!customer) {
      return res.status(404).json({
        success: false,
        message: "Cliente não encontrado",
      });
    }

    const orders = await fetchOrdersForCustomerStats();

    let activationOffers = await fetchActivationOffers();
    activationOffers = filterValidActivationOffers(activationOffers, orders);

    const activationOffer = findActivationOfferForCustomer(customer, activationOffers);
    const orderStats = buildOrderStats(customer, orders);

    return res.status(200).json({
      success: true,
      customer: mapCustomer(customer, activationOffer, orderStats),
    });
  } catch (error) {
    console.error("ERRO AO BUSCAR CLIENTE:", error);

    return res.status(500).json({
      success: false,
      message: "Erro interno ao buscar cliente",
    });
  }
});

export default router;