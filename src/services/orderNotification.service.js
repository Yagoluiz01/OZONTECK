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

function getTrackingCode(order = {}) {
  return order.shipping_tracking_code || order.tracking_code || order.trackingCode || "";
}

function getCarrier(order = {}) {
  return order.shipping_carrier || order.carrier || order.shippingCarrier || "";
}

function baseOrderMetadata(order = {}) {
  return {
    order_number: getOrderNumber(order),
    payment_status: order.payment_status || "",
    order_status: order.order_status || "",
    customer_name: order.customer_name || "",
    customer_email: order.customer_email || "",
    customer_phone: order.customer_phone || "",
    total_amount: order.total_amount || 0,
    tracking_code: getTrackingCode(order),
    shipping_carrier: getCarrier(order),
    shipping_label_status: order.shipping_label_status || "",
    shipping_shipment_id: order.shipping_shipment_id || "",
  };
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
      ...baseOrderMetadata(order),
      payment_status: order.payment_status || "pending",
      order_status: order.order_status || "pending",
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
      ...baseOrderMetadata(order),
      payment_status: order.payment_status || "paid",
      order_status: order.order_status || "paid",
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
      ...baseOrderMetadata(order),
      payment_status: order.payment_status || "pending",
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
      ...baseOrderMetadata(order),
      payment_status: order.payment_status || "failed",
    },
  });
}

export async function notifyOrderShipped(order = {}) {
  const trackingCode = getTrackingCode(order);
  const carrier = getCarrier(order);

  return createAdminNotification({
    type: "order_shipped",
    title: "Pedido enviado",
    message: `Pedido ${getOrderNumber(order)} foi marcado como enviado${
      trackingCode ? ` com rastreio ${trackingCode}` : ""
    }${carrier ? ` pela ${carrier}` : ""}.`,
    entity_type: "order",
    entity_id: order.id || null,
    priority: "high",
    metadata: {
      ...baseOrderMetadata(order),
      order_status: "shipped",
      shipped_at: order.shipped_at || "",
    },
  });
}

export async function notifyOrderDelivered(order = {}) {
  return createAdminNotification({
    type: "order_delivered",
    title: "Pedido entregue",
    message: `Pedido ${getOrderNumber(order)} foi marcado como entregue.`,
    entity_type: "order",
    entity_id: order.id || null,
    priority: "normal",
    metadata: {
      ...baseOrderMetadata(order),
      order_status: "delivered",
      delivered_at: order.delivered_at || "",
    },
  });
}

export async function notifyOrderCancelled(order = {}) {
  return createAdminNotification({
    type: "order_cancelled",
    title: "Pedido cancelado",
    message: `Pedido ${getOrderNumber(order)} foi cancelado.`,
    entity_type: "order",
    entity_id: order.id || null,
    priority: "critical",
    metadata: {
      ...baseOrderMetadata(order),
      order_status: "cancelled",
    },
  });
}

export async function notifyOrderTrackingUpdated(order = {}) {
  const trackingCode = getTrackingCode(order);

  return createAdminNotification({
    type: "order_tracking_updated",
    title: "Rastreio atualizado",
    message: `Pedido ${getOrderNumber(order)} teve o rastreio atualizado${
      trackingCode ? `: ${trackingCode}` : "."
    }`,
    entity_type: "order",
    entity_id: order.id || null,
    priority: "normal",
    metadata: baseOrderMetadata(order),
  });
}

export async function notifyOrderLabelGenerated(order = {}) {
  const trackingCode = getTrackingCode(order);

  return createAdminNotification({
    type: "order_label_generated",
    title: "Etiqueta gerada",
    message: `Etiqueta do pedido ${getOrderNumber(order)} foi gerada${
      trackingCode ? ` com rastreio ${trackingCode}` : ""
    }.`,
    entity_type: "order",
    entity_id: order.id || null,
    priority: "high",
    metadata: {
      ...baseOrderMetadata(order),
      shipping_label_url: order.shipping_label_url || "",
      shipping_label_pdf_url: order.shipping_label_pdf_url || "",
      shipping_label_generated_at: order.shipping_label_generated_at || "",
    },
  });
}

export async function notifyOrderLabelError(order = {}) {
  return createAdminNotification({
    type: "order_label_error",
    title: "Erro na etiqueta",
    message: `Erro ao gerar ou sincronizar etiqueta do pedido ${getOrderNumber(order)}: ${
      order.shipping_label_error || "verifique o Melhor Envio."
    }`,
    entity_type: "order",
    entity_id: order.id || null,
    priority: "critical",
    metadata: {
      ...baseOrderMetadata(order),
      shipping_label_error: order.shipping_label_error || "",
    },
  });
}