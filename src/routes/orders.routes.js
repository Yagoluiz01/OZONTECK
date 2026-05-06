import express from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import {
  notifyOrderPaid,
  notifyOrderShipped,
  notifyOrderDelivered,
  notifyOrderCancelled,
  notifyOrderTrackingUpdated,
  notifyOrderLabelGenerated,
  notifyOrderLabelError,
} from "../services/orderNotification.service.js";
import {
  generateAutomaticShippingLabel,
  syncSpecificMelhorEnvioLabelNow
} from "../services/shipping.service.js";
import { createActivationOfferForPaidOrder } from "../services/customerActivation.service.js";
import { syncAffiliateCommissionLifecycleForOrder } from "../services/affiliateCommissionLifecycle.service.js";

const router = express.Router();

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

function formatCurrency(value) {
  return Number(value || 0).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

function formatDate(value) {
  if (!value) return "-";

  try {
    return new Date(value).toLocaleString("pt-BR");
  } catch {
    return value;
  }
}

function mapOrderStatusLabel(status) {
  const labels = {
    pending: "Pendente",
    paid: "Pago",
    shipped: "Enviado",
    delivered: "Entregue",
    cancelled: "Cancelado",
    failed: "Falhou",
  };

  return labels[String(status || "").toLowerCase()] || "Pendente";
}

function mapPaymentStatusLabel(status) {
  const labels = {
    pending: "Aguardando pagamento",
    paid: "Pagamento confirmado",
    failed: "Pagamento falhou",
    refunded: "Estornado",
    approved: "Aprovado",
    rejected: "Recusado",
  };

  return labels[String(status || "").toLowerCase()] || "Aguardando pagamento";
}

function mapLabelStatusLabel(status) {
  const labels = {
    pending: "Pendente",
    generated: "Gerada",
    cart_created: "Carrinho criado",
    fallback: "Fallback local",
    error: "Erro",
  };

  return labels[String(status || "").toLowerCase()] || "Pendente";
}

function buildAddressLine(order) {
  const parts = [
    order.shipping_address,
    order.shipping_number,
    order.shipping_neighborhood,
    order.shipping_city,
    order.shipping_state,
  ]
    .map((item) => String(item || "").trim())
    .filter(Boolean);

  return parts.length ? parts.join(", ") : "-";
}

function buildFullAddress(order) {
  return {
    cep: order.shipping_cep || "",
    address: order.shipping_address || "",
    number: order.shipping_number || "",
    complement: order.shipping_complement || "",
    neighborhood: order.shipping_neighborhood || "",
    city: order.shipping_city || "",
    state: order.shipping_state || "",
    line: buildAddressLine(order),
  };
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

async function fetchOrderItemsFromRpc(orderId) {
  const response = await callRpc("get_order_items", {
    p_order_id: orderId,
  });

  return Array.isArray(response.data) ? response.data : [];
}

async function fetchOrderTimelineFromRpc(orderId) {
  const response = await callRpc("get_order_timeline", {
    p_order_id: orderId,
  });

  return Array.isArray(response.data) ? response.data : [];
}

async function getOrderItemsForShipping(orderId) {
  const items = await fetchOrderItemsFromRpc(orderId);

  return items.map((item) => ({
    id: item.id,
    product_id: item.product_id || "",
    product_name: item.product_name || "",
    sku: item.sku || "",
    quantity: Number(item.quantity || 1),
  }));
}

function getOrdersSelectFields() {
  return [
    "id",
    "order_number",
    "customer_name",
    "customer_email",
    "customer_phone",
    "customer_cpf",
    "subtotal",
    "shipping_amount",
    "discount_amount",
    "total_amount",
    "payment_status",
    "payment_raw_status",
    "payment_gateway",
    "payment_external_reference",
    "order_status",
    "tracking_code",
    "notes",
    "shipping_cep",
    "shipping_address",
    "shipping_number",
    "shipping_complement",
    "shipping_neighborhood",
    "shipping_city",
    "shipping_state",
    "shipping_carrier",
    "shipping_service_code",
    "shipping_service_name",
    "shipping_delivery_time",
    "shipping_quote_raw",
    "shipping_label_status",
    "shipping_label_url",
    "shipping_label_pdf_url",
    "shipping_tracking_code",
    "shipping_shipment_id",
    "shipping_label_generated_at",
    "shipping_label_error",
    "shipping_label_raw",
    "paid_at",
    "shipped_at",
    "delivered_at",
    "admin_notes",
    "created_at",
  ].join(",");
}

async function fetchOrdersRaw() {
  const url = new URL(`${env.supabaseUrl}/rest/v1/orders`);
  url.searchParams.set("select", getOrdersSelectFields());
  url.searchParams.set("order", "created_at.desc");

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

  return {
    ok: response.ok,
    status: response.status,
    data: Array.isArray(data) ? data : [],
  };
}

async function fetchOrderRawById(orderId) {
  const url = new URL(`${env.supabaseUrl}/rest/v1/orders`);
  url.searchParams.set("select", getOrdersSelectFields());
  url.searchParams.set("id", `eq.${orderId}`);
  url.searchParams.set("limit", "1");

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

  return {
    ok: response.ok,
    status: response.status,
    data: Array.isArray(data) ? data : [],
  };
}

async function fetchOrderItemsCountMap(orderIds = []) {
  const cleanIds = Array.from(
    new Set(
      orderIds
        .map((id) => String(id || "").trim())
        .filter(Boolean)
    )
  );

  const counts = new Map();

  if (!cleanIds.length) {
    return counts;
  }

  const headers = {
    apikey: env.supabaseServiceRoleKey,
    Authorization: `Bearer ${env.supabaseServiceRoleKey}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  const chunkSize = 80;

  for (let index = 0; index < cleanIds.length; index += chunkSize) {
    const chunk = cleanIds.slice(index, index + chunkSize);
    const url = new URL(`${env.supabaseUrl}/rest/v1/order_items`);
    url.searchParams.set("select", "order_id");
    url.searchParams.set("order_id", `in.(${chunk.join(",")})`);

    const response = await fetch(url.toString(), {
      method: "GET",
      headers,
    });

    const data = await response.json().catch(() => []);

    if (!response.ok || !Array.isArray(data)) {
      console.error("ERRO AO BUSCAR CONTAGEM DE ITENS DOS PEDIDOS:", data);
      continue;
    }

    data.forEach((item) => {
      const orderId = String(item?.order_id || "").trim();

      if (!orderId) {
        return;
      }

      counts.set(orderId, (counts.get(orderId) || 0) + 1);
    });
  }

  return counts;
}

async function updateOrderRecord(orderId, payload) {
  const url = new URL(`${env.supabaseUrl}/rest/v1/orders`);
  url.searchParams.set("id", `eq.${orderId}`);
  url.searchParams.set("select", "*");

  const response = await fetch(url.toString(), {
    method: "PATCH",
    headers: {
      apikey: env.supabaseServiceRoleKey,
      Authorization: `Bearer ${env.supabaseServiceRoleKey}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json().catch(() => []);

  return {
    ok: response.ok,
    status: response.status,
    data: Array.isArray(data) ? data : [],
  };
}

async function createActivationOfferSafely(order, source = "orders_routes") {
  try {
    const result = await createActivationOfferForPaidOrder(order);

    console.log("CUSTOMER ACTIVATION OFFER RESULT:", {
      source,
      orderId: order?.id || null,
      orderNumber: order?.order_number || null,
      created: result?.created || false,
      skipped: result?.skipped || false,
      reason: result?.reason || "",
    });

    return result;
  } catch (error) {
    console.error("ERRO AO CRIAR CONDIÇÃO DE ATIVAÇÃO:", {
      source,
      orderId: order?.id || null,
      orderNumber: order?.order_number || null,
      error: error?.message || String(error),
    });

    return {
      success: false,
      created: false,
      skipped: false,
      reason: "activation_offer_unexpected_error",
      error: error?.message || String(error),
    };
  }
}


async function addTimelineEvent(orderId, label, description) {   
  return callRpc("add_order_timeline_event", { 
    p_order_id: orderId,
    p_event_label: label,
    p_event_description: description,
  });
}

async function buildOrderDetails(order) {
  const [items, timeline] = await Promise.all([
    fetchOrderItemsFromRpc(order.id),
    fetchOrderTimelineFromRpc(order.id),
  ]);

  return {
    id: order.id,
    order_number: order.order_number,
    customer_name: order.customer_name,
    customer_email: order.customer_email,
    customer_phone: order.customer_phone || "",
    customer_cpf: order.customer_cpf || "",
    created_at: order.created_at,
    payment_status: order.payment_status || "pending",
    payment_raw_status: order.payment_raw_status || "",
    payment_gateway: order.payment_gateway || "",
    payment_external_reference: order.payment_external_reference || "",
    total_amount: Number(order.total_amount || 0),
    subtotal: Number(order.subtotal || 0),
    shipping_amount: Number(order.shipping_amount || 0),
    discount_amount: Number(order.discount_amount || 0),
    order_status: order.order_status || "pending",
    tracking_code: order.tracking_code || "",
    shipping_tracking_code:
      order.shipping_tracking_code || order.tracking_code || "",
    shipping_carrier: order.shipping_carrier || "",
    shipping_service_code: order.shipping_service_code || "",
    shipping_service_name: order.shipping_service_name || "",
    shipping_delivery_time: order.shipping_delivery_time ?? null,
    shipping_label_status: order.shipping_label_status || "pending",
    shipping_label_url: order.shipping_label_url || "",
    shipping_label_pdf_url: order.shipping_label_pdf_url || "",
    shipping_shipment_id: order.shipping_shipment_id || "",
    shipping_label_generated_at: order.shipping_label_generated_at || "",
    shipping_label_error: order.shipping_label_error || "",
    shipping_label_raw: order.shipping_label_raw || null,
    paid_at: order.paid_at || "",
    shipped_at: order.shipped_at || "",
    delivered_at: order.delivered_at || "",
    notes: order.notes || "",
    admin_notes: order.admin_notes || "",
    shipping_cep: order.shipping_cep || "",
    shipping_address: order.shipping_address || "",
    shipping_number: order.shipping_number || "",
    shipping_complement: order.shipping_complement || "",
    shipping_neighborhood: order.shipping_neighborhood || "",
    shipping_city: order.shipping_city || "",
    shipping_state: order.shipping_state || "",

    number: order.order_number,
    customerName: order.customer_name,
    customerEmail: order.customer_email,
    customerPhone: order.customer_phone || "",
    customerCpf: order.customer_cpf || "",
    date: formatDate(order.created_at),
    paymentStatus: order.payment_status || "pending",
    paymentLabel: mapPaymentStatusLabel(order.payment_status),
    total: formatCurrency(order.total_amount),
    subtotalFormatted: formatCurrency(order.subtotal),
    shippingAmountFormatted: formatCurrency(order.shipping_amount),
    discountAmountFormatted: formatCurrency(order.discount_amount),
    status: order.order_status || "pending",
    statusLabel: mapOrderStatusLabel(order.order_status),
    trackingCode: order.tracking_code || "",
    shippingTrackingCode:
      order.shipping_tracking_code || order.tracking_code || "",
    shippingCarrier: order.shipping_carrier || "",
    shippingLabelStatus: order.shipping_label_status || "pending",
    shippingLabelStatusLabel: mapLabelStatusLabel(order.shipping_label_status),
    shippingLabelUrl: order.shipping_label_url || "",
    shippingLabelPdfUrl: order.shipping_label_pdf_url || "",
    shippingShipmentId: order.shipping_shipment_id || "",
    shippingLabelGeneratedAt: order.shipping_label_generated_at
      ? formatDate(order.shipping_label_generated_at)
      : "",
    shippingLabelError: order.shipping_label_error || "",
    shippedAt: order.shipped_at ? formatDate(order.shipped_at) : "",
    deliveredAt: order.delivered_at ? formatDate(order.delivered_at) : "",
    paidAt: order.paid_at ? formatDate(order.paid_at) : "",
    notesFormatted: order.notes || "",
    adminNotes: order.admin_notes || "",
    address: buildFullAddress(order),
    itemsCount: items.length,
    items: items.map((item) => ({
      id: item.id,
      product_id: item.product_id || "",
      product_name: item.product_name,
      unit_price: Number(item.unit_price || 0),
      total_price: Number(item.total_price || 0),
      name: item.product_name,
      quantity: Number(item.quantity || 0),
      price: formatCurrency(item.unit_price),
      total: formatCurrency(item.total_price),
      sku: item.sku || "",
    })),
    timeline: timeline.map((event) => ({
      id: event.id,
      event_label: event.event_label,
      event_description: event.event_description || "",
      created_at: event.created_at,
      label: event.event_label,
      description: event.event_description || "",
      date: formatDate(event.created_at),
    })),
  };
}

router.get("/", requireAuth, async (req, res) => {
  try {
    const search = String(req.query.search || "").trim().toLowerCase();
    const status = String(req.query.status || "all").trim().toLowerCase();

    const response = await fetchOrdersRaw();

    if (!response.ok) {
      return res.status(500).json({
        success: false,
        message: "Erro ao buscar pedidos",
        details: response.data,
      });
    }

    let orders = response.data;

    if (search) {
      orders = orders.filter((order) => {
        const orderNumber = String(order.order_number || "").toLowerCase();
        const customerName = String(order.customer_name || "").toLowerCase();
        const customerEmail = String(order.customer_email || "").toLowerCase();
        const trackingCode = String(
          order.shipping_tracking_code || order.tracking_code || ""
        ).toLowerCase();
        const addressLine = buildAddressLine(order).toLowerCase();

        return (
          orderNumber.includes(search) ||
          customerName.includes(search) ||
          customerEmail.includes(search) ||
          trackingCode.includes(search) ||
          addressLine.includes(search)
        );
      });
    }

    if (status !== "all") {
      orders = orders.filter(
        (order) => String(order.order_status || "").toLowerCase() === status
      );
    }

    const orderItemCounts = await fetchOrderItemsCountMap(
      orders.map((order) => order.id)
    );

    const normalizedOrders = orders.map((order) => ({
      id: order.id,
      order_number: order.order_number,
      customer_name: order.customer_name,
      customer_email: order.customer_email,
      customer_phone: order.customer_phone || "",
      created_at: order.created_at,
      payment_status: order.payment_status || "pending",
      payment_raw_status: order.payment_raw_status || "",
      total_amount: Number(order.total_amount || 0),
      subtotal: Number(order.subtotal || 0),
      shipping_amount: Number(order.shipping_amount || 0),
      discount_amount: Number(order.discount_amount || 0),
      order_status: order.order_status || "pending",
      tracking_code: order.tracking_code || "",
      shipping_tracking_code:
        order.shipping_tracking_code || order.tracking_code || "",
      shipping_carrier: order.shipping_carrier || "",
      shipping_label_status: order.shipping_label_status || "pending",
      shipping_label_url: order.shipping_label_url || "",
      shipping_label_pdf_url: order.shipping_label_pdf_url || "",
      shipping_shipment_id: order.shipping_shipment_id || "",
      shipping_label_generated_at: order.shipping_label_generated_at || "",
      shipping_label_error: order.shipping_label_error || "",

      number: order.order_number,
      customerName: order.customer_name,
      customerEmail: order.customer_email,
      customerPhone: order.customer_phone || "",
      date: formatDate(order.created_at),
      paymentStatus: order.payment_status || "pending",
      paymentLabel: mapPaymentStatusLabel(order.payment_status),
      total: formatCurrency(order.total_amount),
      status: order.order_status || "pending",
      statusLabel: mapOrderStatusLabel(order.order_status),
      trackingCode: order.tracking_code || "",
      shippingTrackingCode:
        order.shipping_tracking_code || order.tracking_code || "",
      shippingCarrier: order.shipping_carrier || "",
      shippingLabelStatus: order.shipping_label_status || "pending",
      shippingLabelStatusLabel: mapLabelStatusLabel(order.shipping_label_status),
      shippingLabelUrl: order.shipping_label_url || "",
      shippingLabelPdfUrl: order.shipping_label_pdf_url || "",
      shippingShipmentId: order.shipping_shipment_id || "",
      shippingLabelGeneratedAt: order.shipping_label_generated_at
        ? formatDate(order.shipping_label_generated_at)
        : "",
      shippingLabelError: order.shipping_label_error || "",
      addressLine: buildAddressLine(order),
      itemsCount: orderItemCounts.get(String(order.id || "")) || 0,
    }));

    return res.status(200).json({
      success: true,
      orders: normalizedOrders,
    });
  } catch (error) {
    console.error("ERRO AO LISTAR PEDIDOS:", error);

    return res.status(500).json({
      success: false,
      message: "Erro interno ao listar pedidos",
    });
  }
});

router.get("/:id", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const response = await fetchOrderRawById(id);

    if (!response.ok) {
      return res.status(500).json({
        success: false,
        message: "Erro ao buscar pedido",
        details: response.data,
      });
    }

    const order = response.data[0] || null;

    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Pedido não encontrado",
      });
    }

    const normalizedOrder = await buildOrderDetails(order);

    return res.status(200).json({
      success: true,
      order: normalizedOrder,
    });
  } catch (error) {
    console.error("ERRO AO BUSCAR DETALHES DO PEDIDO:", error);

    return res.status(500).json({
      success: false,
      message: "Erro interno ao buscar detalhes do pedido",
    });
  }
});

router.put("/:id/tracking", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const {
      trackingCode = "",
      status = "pending",
      note = "",
      shippingCarrier = "",
      adminNotes = "",
    } = req.body || {};

    if (!id) {
      return res.status(400).json({
        success: false,
        message: "ID do pedido é obrigatório",
      });
    }

    if (!["pending", "paid", "shipped", "delivered", "cancelled"].includes(String(status))) {
      return res.status(400).json({
        success: false,
        message: "Status do pedido inválido",
      });
    }

    const normalizedStatus = String(status || "pending").trim().toLowerCase();

    const orderResponse = await fetchOrderRawById(id);
    const existingOrder = orderResponse.data[0] || null;

    if (!orderResponse.ok || !existingOrder) {
      return res.status(404).json({
        success: false,
        message: "Pedido não encontrado",
      });
    }

    const updatePayload = {
      tracking_code: String(trackingCode || "").trim(),
      order_status: normalizedStatus,
      shipping_carrier: String(shippingCarrier || "").trim(),
      admin_notes: String(adminNotes || "").trim(),
    };

    if (normalizedStatus === "paid") {
      updatePayload.payment_status = "paid";

      if (!existingOrder.paid_at) {
        updatePayload.paid_at = new Date().toISOString();
      }
    }

    if (normalizedStatus === "shipped" && !existingOrder.shipped_at) {
      updatePayload.shipped_at = new Date().toISOString();
    }

    if (normalizedStatus === "delivered") {
      updatePayload.delivered_at = new Date().toISOString();
    }

    const currentLabelStatus = String(existingOrder.shipping_label_status || "")
      .trim()
      .toLowerCase();

    const shouldGenerateLabel =
      normalizedStatus === "paid" &&
      !["generated", "cart_created"].includes(currentLabelStatus);

    if (shouldGenerateLabel) {
      const shippingItems = await getOrderItemsForShipping(existingOrder.id);
      const labelResult = await generateAutomaticShippingLabel(existingOrder, shippingItems);

      updatePayload.shipping_label_status = labelResult.labelStatus;
      updatePayload.shipping_label_url = labelResult.labelUrl;
      updatePayload.shipping_label_pdf_url = labelResult.labelPdfUrl;
      updatePayload.shipping_tracking_code =
        labelResult.trackingCode || String(trackingCode || "").trim() || "";
      updatePayload.shipping_shipment_id = labelResult.shipmentId || "";
      updatePayload.shipping_label_generated_at = new Date().toISOString();
      updatePayload.shipping_label_error = labelResult.error || "";
      updatePayload.shipping_label_raw = labelResult.raw || null;

      if (!updatePayload.shipping_carrier) {
        updatePayload.shipping_carrier = labelResult.carrier || "";
      }

      if (!updatePayload.tracking_code && labelResult.trackingCode) {
        updatePayload.tracking_code = labelResult.trackingCode;
      }
    }

    const updateResponse = await updateOrderRecord(id, updatePayload);

    if (!updateResponse.ok || !updateResponse.data[0]) {
      return res.status(500).json({
        success: false,
        message: "Erro ao atualizar rastreio do pedido",
        details: updateResponse.data,
      });
    }

    const updatedOrder = updateResponse.data[0];

    const statusLabel = mapOrderStatusLabel(normalizedStatus);
    const eventLabel =
      normalizedStatus === "shipped"
        ? "Pedido enviado"
        : normalizedStatus === "delivered"
        ? "Pedido entregue"
        : normalizedStatus === "paid"
        ? "Pagamento confirmado"
        : normalizedStatus === "cancelled"
        ? "Pedido cancelado"
        : `Status alterado para ${statusLabel}`;

    const timelineParts = [];

    if (String(updatePayload.shipping_carrier || "").trim()) {
      timelineParts.push(
        `Transportadora: ${String(updatePayload.shipping_carrier).trim()}.`
      );
    }

    if (String(updatePayload.tracking_code || "").trim()) {
      timelineParts.push(
        `Código de rastreio: ${String(updatePayload.tracking_code).trim()}.`
      );
    }

    if (String(note || "").trim()) {
      timelineParts.push(String(note).trim());
    }

    if (String(adminNotes || "").trim()) {
      timelineParts.push(`Observação interna: ${String(adminNotes).trim()}`);
    }

    if (shouldGenerateLabel) {
      const labelStatusLabel = mapLabelStatusLabel(updatePayload.shipping_label_status);

      timelineParts.push(
        `Etiqueta processada automaticamente: ${labelStatusLabel}.`
      );

      if (String(updatePayload.shipping_shipment_id || "").trim()) {
        timelineParts.push(
          `ID do carrinho/envio: ${String(updatePayload.shipping_shipment_id).trim()}.`
        );
      }

      if (String(updatePayload.shipping_label_pdf_url || "").trim()) {
        timelineParts.push(
          `URL da etiqueta: ${String(updatePayload.shipping_label_pdf_url).trim()}.`
        );
      }

      if (String(updatePayload.shipping_label_error || "").trim()) {
        timelineParts.push(
          `Detalhe: ${String(updatePayload.shipping_label_error).trim()}.`
        );
      }
    }

    const eventDescription =
      timelineParts.join(" ") || `Pedido atualizado para o status ${statusLabel}.`;

    const eventResponse = await addTimelineEvent(id, eventLabel, eventDescription);

    if (!eventResponse.ok) {
      return res.status(500).json({
        success: false,
        message: "Pedido atualizado, mas houve erro ao registrar timeline",
        details: eventResponse.data,
      });
    }

    const refreshedOrderResponse = await fetchOrderRawById(id);
    const refreshedOrder = refreshedOrderResponse.data[0] || null;

    if (!refreshedOrderResponse.ok || !refreshedOrder) {
      return res.status(500).json({
        success: false,
        message: "Pedido atualizado, mas houve erro ao recarregar os dados",
      });
    }

    if (normalizedStatus === "paid") {
      await createActivationOfferSafely(refreshedOrder, "admin_order_update_paid");
    }

    const affiliateLifecycleResult = await syncAffiliateCommissionLifecycleForOrder(
      refreshedOrder,
      `admin_order_update_${normalizedStatus}`
    );

    console.log("AFFILIATE COMMISSION LIFECYCLE ADMIN UPDATE:", affiliateLifecycleResult);

    setTimeout(() => {
      const previousStatus = String(existingOrder.order_status || "")
        .trim()
        .toLowerCase();

      const newStatus = String(refreshedOrder.order_status || "")
        .trim()
        .toLowerCase();

      const previousTracking = String(
        existingOrder.shipping_tracking_code || existingOrder.tracking_code || ""
      ).trim();

      const newTracking = String(
        refreshedOrder.shipping_tracking_code || refreshedOrder.tracking_code || ""
      ).trim();

      const previousLabelStatus = String(existingOrder.shipping_label_status || "")
        .trim()
        .toLowerCase();

      const newLabelStatus = String(refreshedOrder.shipping_label_status || "")
        .trim()
        .toLowerCase();

      Promise.resolve()
        .then(async () => {
          if (previousStatus !== newStatus) {
            if (newStatus === "paid") {
              await notifyOrderPaid(refreshedOrder);
            }

            if (newStatus === "shipped") {
              await notifyOrderShipped(refreshedOrder);
            }

            if (newStatus === "delivered") {
              await notifyOrderDelivered(refreshedOrder);
            }

            if (newStatus === "cancelled") {
              await notifyOrderCancelled(refreshedOrder);
            }
          }

          if (newTracking && newTracking !== previousTracking) {
            await notifyOrderTrackingUpdated(refreshedOrder);
          }

          if (newLabelStatus === "generated" && previousLabelStatus !== "generated") {
            await notifyOrderLabelGenerated(refreshedOrder);
          }

          if (newLabelStatus === "error" && previousLabelStatus !== "error") {
            await notifyOrderLabelError(refreshedOrder);
          }
        })
        .catch((notificationError) => {
          console.error(
            "ERRO AO ENVIAR NOTIFICAÇÃO DE ATUALIZAÇÃO DO PEDIDO:",
            notificationError
          );
        });
    }, 0);

    const normalizedOrder = await buildOrderDetails(refreshedOrder);

    return res.status(200).json({
      success: true,
      message: shouldGenerateLabel
        ? "Pedido atualizado e carrinho do Melhor Envio processado com sucesso"
        : "Pedido atualizado com sucesso",
      order: normalizedOrder,
    });
  } catch (error) {
    console.error("ERRO AO ATUALIZAR RASTREIO:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Erro interno ao atualizar rastreio",
    });
  }
});


router.post("/:id/sync-melhor-envio-now", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({
        success: false,
        message: "ID do pedido é obrigatório",
      });
    }

    const orderResponse = await fetchOrderRawById(id);
    const existingOrder = orderResponse.data[0] || null;

    if (!orderResponse.ok || !existingOrder) {
      return res.status(404).json({
        success: false,
        message: "Pedido não encontrado",
      });
    }

    if (!String(existingOrder.shipping_shipment_id || "").trim()) {
      return res.status(400).json({
        success: false,
        message: "Pedido sem ID de envio/carrinho para sincronização",
      });
    }

    const previousLabelStatus = String(existingOrder.shipping_label_status || "")
      .trim()
      .toLowerCase();

    const previousLabelUrl = String(
      existingOrder.shipping_label_pdf_url ||
        existingOrder.shipping_label_url ||
        ""
    ).trim();

    const previousTracking = String(
      existingOrder.shipping_tracking_code ||
        existingOrder.tracking_code ||
        ""
    ).trim();

    const syncResult = await syncSpecificMelhorEnvioLabelNow(existingOrder);

    const refreshedOrderResponse = await fetchOrderRawById(id);
    const refreshedOrder = refreshedOrderResponse.data[0] || null;

    if (!refreshedOrderResponse.ok || !refreshedOrder) {
      return res.status(500).json({
        success: false,
        message: "Sincronização executada, mas houve erro ao recarregar o pedido",
      });
    }

    const generatedNow = syncResult?.status === "generated";

    const currentLabelStatus = String(refreshedOrder.shipping_label_status || "")
      .trim()
      .toLowerCase();

    const currentLabelUrl = String(
      refreshedOrder.shipping_label_pdf_url ||
        refreshedOrder.shipping_label_url ||
        ""
    ).trim();

    const currentTracking = String(
      refreshedOrder.shipping_tracking_code ||
        refreshedOrder.tracking_code ||
        ""
    ).trim();

    const labelWasFoundNow =
      generatedNow &&
      (
        previousLabelStatus !== "generated" ||
        !previousLabelUrl ||
        !previousTracking
      ) &&
      (
        currentLabelStatus === "generated" ||
        currentLabelUrl ||
        currentTracking
      );

    const labelHasError =
      syncResult?.status === "error" ||
      currentLabelStatus === "error";

    if (labelWasFoundNow) {
      setTimeout(() => {
        notifyOrderLabelGenerated(refreshedOrder).catch((notificationError) => {
          console.error(
            "ERRO AO ENVIAR NOTIFICAÇÃO DE ETIQUETA ENCONTRADA:",
            notificationError
          );
        });
      }, 0);
    }

    if (labelHasError && previousLabelStatus !== "error") {
      setTimeout(() => {
        notifyOrderLabelError(refreshedOrder).catch((notificationError) => {
          console.error(
            "ERRO AO ENVIAR NOTIFICAÇÃO DE ERRO NA ETIQUETA:",
            notificationError
          );
        });
      }, 0);
    }

    const affiliateLifecycleResult = await syncAffiliateCommissionLifecycleForOrder(
      refreshedOrder,
      "melhor_envio_sync"
    );

    console.log("AFFILIATE COMMISSION LIFECYCLE MELHOR ENVIO SYNC:", affiliateLifecycleResult);

    const normalizedOrder = await buildOrderDetails(refreshedOrder);
    

    return res.status(200).json({
      success: true,
      message: generatedNow
        ? "Etiqueta sincronizada com sucesso"
        : "Sincronização executada, mas a etiqueta ainda não está disponível no Melhor Envio",
      sync: syncResult,
      order: normalizedOrder,
    });
  } catch (error) {
    console.error("ERRO AO SINCRONIZAR ETIQUETA AGORA:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Erro interno ao sincronizar etiqueta agora",
    });
  }
});

export default router;