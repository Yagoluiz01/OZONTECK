import { createAdminNotification } from "./adminNotifications.service.js";

function getOrderNumber(order = {}) {
  return order.order_number || order.number || order.id || "sem número";
}

function getOrderTotal(order = {}) {
  const total = Number(order.total_amount || order.total || 0);

  return total.toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

export async function notifyOrderCreatedPending(order = {}) {
  return createAdminNotification({
    type: "order_created_pending",
    title: "Novo pedido criado",
    message: `Pedido ${getOrderNumber(order)} criado e aguardando pagamento. Total: ${getOrderTotal(order)}.`,
    entity_type: "order",
    entity_id: order.id || null,
    priority: "normal",
    metadata: {
      order_number: getOrderNumber(order),
      payment_status: order.payment_status || "pending",
      order_status: order.order_status || "pending",
      customer_name: order.customer_name || "",
      customer_email: order.customer_email || "",
      total_amount: order.total_amount || 0,
    },
  });
}

export async function notifyOrderPaid(order = {}) {
  return createAdminNotification({
    type: "order_paid",
    title: "Pedido pago",
    message: `Pedido ${getOrderNumber(order)} foi pago. Total: ${getOrderTotal(order)}.`,
    entity_type: "order",
    entity_id: order.id || null,
    priority: "high",
    metadata: {
      order_number: getOrderNumber(order),
      payment_status: order.payment_status || "paid",
      order_status: order.order_status || "paid",
      customer_name: order.customer_name || "",
      customer_email: order.customer_email || "",
      total_amount: order.total_amount || 0,
    },
  });
}

export async function notifyOrderPaymentPending(order = {}) {
  return createAdminNotification({
    type: "order_payment_pending",
    title: "Pagamento pendente",
    message: `Pedido ${getOrderNumber(order)} está com pagamento pendente.`,
    entity_type: "order",
    entity_id: order.id || null,
    priority: "normal",
    metadata: {
      order_number: getOrderNumber(order),
      payment_status: order.payment_status || "pending",
      order_status: order.order_status || "",
      customer_name: order.customer_name || "",
      customer_email: order.customer_email || "",
      total_amount: order.total_amount || 0,
    },
  });
}

export async function notifyOrderPaymentFailed(order = {}) {
  return createAdminNotification({
    type: "order_payment_failed",
    title: "Pagamento recusado ou cancelado",
    message: `Pedido ${getOrderNumber(order)} teve pagamento recusado, cancelado ou falhou.`,
    entity_type: "order",
    entity_id: order.id || null,
    priority: "critical",
    metadata: {
      order_number: getOrderNumber(order),
      payment_status: order.payment_status || "failed",
      order_status: order.order_status || "",
      customer_name: order.customer_name || "",
      customer_email: order.customer_email || "",
      total_amount: order.total_amount || 0,
    },
  });
}