import { env } from "../config/env.js";
import { createAdminNotification } from "./adminNotifications.service.js";
import { sendPushToAffiliate } from "./affiliatePush.service.js";

function getHeaders() {
  return {
    apikey: env.supabaseServiceRoleKey,
    Authorization: `Bearer ${env.supabaseServiceRoleKey}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

function normalizeStatus(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function isDeliveredOrder(order = {}) {
  const raw = order?.shipping_label_raw && typeof order.shipping_label_raw === "object"
    ? order.shipping_label_raw
    : {};

  const statuses = [
    order.order_status,
    order.shipping_status,
    order.shipping_state,
    order.delivery_status,
    order.tracking_status,
    raw.sync_tracking_status,
  ].map(normalizeStatus);

  return Boolean(order.delivered_at) || statuses.some((status) => [
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
  ].includes(status));
}

function isCancelledOrder(order = {}) {
  const statuses = [
    order.order_status,
    order.payment_status,
    order.payment_raw_status,
  ].map(normalizeStatus);

  return statuses.some((status) => [
    "cancelled",
    "canceled",
    "cancelado",
    "cancelada",
    "refunded",
    "estornado",
    "estornada",
    "charged_back",
    "chargeback",
    "rejected",
    "failed",
  ].includes(status));
}

function formatMoneyBR(value) {
  return Number(value || 0).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

async function fetchOrder(orderId) {
  const id = String(orderId || "").trim();
  if (!id) return null;

  const url = new URL(`${env.supabaseUrl}/rest/v1/orders`);
  url.searchParams.set("id", `eq.${id}`);
  url.searchParams.set("select", "*");
  url.searchParams.set("limit", "1");

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: getHeaders(),
  });

  const data = await response.json().catch(() => []);

  if (!response.ok) {
    throw new Error(data?.message || data?.details || "Erro ao consultar pedido da meta por produto.");
  }

  return Array.isArray(data) ? data[0] || null : null;
}

async function callProductGoalRpc({ affiliateId, orderId, source }) {
  const response = await fetch(
    `${env.supabaseUrl}/rest/v1/rpc/process_affiliate_product_goal_bonuses`,
    {
      method: "POST",
      headers: getHeaders(),
      body: JSON.stringify({
        p_affiliate_id: affiliateId,
        p_order_id: orderId || null,
        p_source: String(source || "order_lifecycle").slice(0, 180),
      }),
    }
  );

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    const error = new Error(
      data?.message ||
        data?.details ||
        data?.hint ||
        "Erro ao processar bônus da meta específica por produto."
    );
    error.statusCode = response.status;
    error.details = data;
    throw error;
  }

  return data && typeof data === "object" ? data : { success: true, events: [] };
}

async function notifyReleasedEvent(event = {}) {
  const affiliateId = String(event.affiliate_id || "").trim();
  const amount = Number(event.bonus_amount || 0);
  const levelName = String(event.level_name || "nível atual").trim();

  if (!affiliateId || amount <= 0) return;

  await Promise.allSettled([
    sendPushToAffiliate(affiliateId, {
      title: "🎁 Bônus liberado",
      body: `Você concluiu a meta específica do produto no nível ${levelName}. Bônus liberado: ${formatMoneyBR(amount)}.`,
      url: "/pages-html/afiliado-painel.html",
      data: {
        type: "affiliate_product_goal_bonus_released",
        affiliate_id: affiliateId,
        product_id: event.product_id || null,
        target_id: event.target_id || null,
        completion_id: event.completion_id || null,
        conversion_id: event.conversion_id || null,
        bonus_amount: amount,
      },
    }),
    createAdminNotification({
      type: "affiliate_product_goal_bonus_released",
      title: "Bônus de meta por produto liberado",
      message: `Um afiliado concluiu a meta específica de produto e recebeu ${formatMoneyBR(amount)} no nível ${levelName}.`,
      entity_type: "affiliate_product_goal_completion",
      entity_id: event.completion_id || null,
      priority: "high",
      metadata: event,
    }),
  ]);
}

async function notifyReviewEvent(event = {}) {
  await createAdminNotification({
    type: "affiliate_product_goal_bonus_review_required",
    title: "Revisão necessária em bônus de meta",
    message:
      "As unidades válidas ficaram abaixo da meta depois que o bônus já havia sido pago. Revise o afiliado e o pedido.",
    entity_type: "affiliate_product_goal_completion",
    entity_id: event.completion_id || null,
    priority: "critical",
    metadata: event,
  });
}

export async function syncAffiliateProductGoalLifecycleForOrder(
  orderInput,
  source = "order_lifecycle"
) {
  const order = orderInput?.id ? orderInput : await fetchOrder(orderInput);

  if (!order?.id) {
    return {
      success: false,
      skipped: true,
      reason: "order_not_found",
    };
  }

  if (!isDeliveredOrder(order) && !isCancelledOrder(order)) {
    return {
      success: true,
      skipped: true,
      reason: "order_without_product_goal_action",
      orderId: order.id,
    };
  }

  const affiliateId = String(order.affiliate_id || "").trim();

  if (!affiliateId) {
    return {
      success: true,
      skipped: true,
      reason: "order_without_affiliate",
      orderId: order.id,
    };
  }

  const result = await callProductGoalRpc({
    affiliateId,
    orderId: order.id,
    source,
  });

  const events = Array.isArray(result?.events) ? result.events : [];

  for (const event of events) {
    if (event?.action === "released") {
      await notifyReleasedEvent(event).catch((error) => {
        console.error("AFFILIATE PRODUCT GOAL RELEASE NOTIFICATION ERROR:", {
          orderId: order.id,
          affiliateId,
          message: error?.message || String(error),
        });
      });
    }

    if (event?.action === "review_required") {
      await notifyReviewEvent(event).catch((error) => {
        console.error("AFFILIATE PRODUCT GOAL REVIEW NOTIFICATION ERROR:", {
          orderId: order.id,
          affiliateId,
          message: error?.message || String(error),
        });
      });
    }
  }

  console.log("AFFILIATE PRODUCT GOAL LIFECYCLE RESULT:", {
    orderId: order.id,
    orderNumber: order.order_number || null,
    affiliateId,
    source,
    events,
  });

  return {
    success: true,
    skipped: false,
    orderId: order.id,
    affiliateId,
    events,
    result,
  };
}
