import { env } from "../config/env.js";
import {
  emitInvoiceForOrder,
  appendOrderProcessingEvent,
  updateOrderInvoiceFields
} from "../services/invoice.service.js";
import { generateAutomaticShippingLabel } from "../services/shipping.service.js";
import { ensureOrderStockReserved } from "../services/orderStock.service.js";

function getRequiredEnv(name, value) {
  const normalized = String(value || "").trim();

  if (!normalized) {
    throw new Error(`Variável obrigatória ausente: ${name}`);
  }

  return normalized;
}

function getSupabaseUrl() {
  return getRequiredEnv("SUPABASE_URL", env.supabaseUrl);
}

function getSupabaseHeaders() {
  const serviceRoleKey = getRequiredEnv(
    "SUPABASE_SERVICE_ROLE_KEY",
    env.supabaseServiceRoleKey
  );

  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json",
    Accept: "application/json"
  };
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => null);

  return {
    response,
    data
  };
}

async function findOrderById(orderId) {
  const url = new URL(`${getSupabaseUrl()}/rest/v1/orders`);
  url.searchParams.set("id", `eq.${orderId}`);
  url.searchParams.set("select", "*");
  url.searchParams.set("limit", "1");

  const { response, data } = await fetchJson(url.toString(), {
    method: "GET",
    headers: getSupabaseHeaders()
  });

  if (!response.ok) {
    throw new Error("Erro ao consultar pedido");
  }

  return Array.isArray(data) ? data[0] || null : null;
}

async function findOrderByNumber(orderNumber) {
  const url = new URL(`${getSupabaseUrl()}/rest/v1/orders`);
  url.searchParams.set("order_number", `eq.${orderNumber}`);
  url.searchParams.set("select", "*");
  url.searchParams.set("limit", "1");

  const { response, data } = await fetchJson(url.toString(), {
    method: "GET",
    headers: getSupabaseHeaders()
  });

  if (!response.ok) {
    throw new Error("Erro ao consultar pedido por número");
  }

  return Array.isArray(data) ? data[0] || null : null;
}

async function findOrderItems(orderId) {
  const url = new URL(`${getSupabaseUrl()}/rest/v1/order_items`);
  url.searchParams.set("order_id", `eq.${orderId}`);
  url.searchParams.set("select", "*");

  const { response, data } = await fetchJson(url.toString(), {
    method: "GET",
    headers: getSupabaseHeaders()
  });

  if (!response.ok) {
    throw new Error("Erro ao consultar itens do pedido");
  }

  return Array.isArray(data) ? data : [];
}

async function updateOrder(orderId, patch = {}) {
  const url = new URL(`${getSupabaseUrl()}/rest/v1/orders`);
  url.searchParams.set("id", `eq.${orderId}`);

  const { response, data } = await fetchJson(url.toString(), {
    method: "PATCH",
    headers: {
      ...getSupabaseHeaders(),
      Prefer: "return=representation"
    },
    body: JSON.stringify(patch)
  });

  if (!response.ok) {
    throw new Error("Erro ao atualizar pedido");
  }

  return Array.isArray(data) ? data[0] || null : data;
}

function normalizePaymentStatus(order) {
  return String(
    order?.payment_status ||
      order?.status ||
      ""
  )
    .trim()
    .toLowerCase();
}

function isAlreadyProcessed(order) {
  const status = String(order?.shipping_label_status || "").trim().toLowerCase();
  const hasShipmentId = String(order?.shipping_shipment_id || "").trim();

  if (hasShipmentId) {
    return !["error", "blocked_me_cart_403", "invalid_order", "invalid_items", "invalid_address", "missing_service"]
      .includes(status);
  }

  return ["generated", "shipped", "posted", "delivered"]
    .includes(status);
}

function isInvoiceAuthorized(order) {
  return String(order?.invoice_status || "").trim().toLowerCase() === "authorized" &&
    String(order?.invoice_key || "").trim();
}

async function markOrderAsPaid(order) {
  return updateOrder(order.id, {
    payment_status: "paid",
    paid_at: order?.paid_at || new Date().toISOString(),
    processed_at: new Date().toISOString()
  });
}

async function markOrderAwaitingInvoice(order) {
  return updateOrder(order.id, {
    payment_status: "paid",
    invoice_status: "awaiting_invoice",
    shipping_label_status: "pending",
    processed_at: new Date().toISOString()
  });
}

async function markOrderAwaitingShippingLabel(order, invoiceResult = null) {
  const invoiceIsAuthorized =
    isInvoiceAuthorized(order) || Boolean(invoiceResult?.success);

  const patch = {
    processed_at: new Date().toISOString()
  };

  if (invoiceIsAuthorized) {
    patch.invoice_status = "authorized";
  }

  return updateOrder(order.id, patch);
}

function normalizeShippingLabelStatusForOrder(shippingResult) {
  const success = Boolean(shippingResult?.success);
  const status = String(shippingResult?.labelStatus || "").trim().toLowerCase();
  const hasShipmentId = String(shippingResult?.shipmentId || "").trim();

  if (success && (status === "cart_created" || (hasShipmentId && status !== "generated"))) {
    return "awaiting_shipping_label";
  }

  if (status) {
    return status;
  }

  return success ? "generated" : "error";
}

async function saveShippingResult(order, shippingResult) {
  const normalizedLabelStatus = normalizeShippingLabelStatusForOrder(shippingResult);
  const generated = Boolean(shippingResult?.success) && normalizedLabelStatus === "generated";
  const shipmentId = String(shippingResult?.shipmentId || "").trim();
  const labelUrl = String(shippingResult?.labelUrl || "").trim();
  const labelPdfUrl = String(shippingResult?.labelPdfUrl || "").trim();
  const trackingCode = String(shippingResult?.trackingCode || "").trim();

  const patch = {
    shipping_label_status: normalizedLabelStatus,
    shipping_label_error: shippingResult?.error || null,
    shipping_label_raw: shippingResult?.raw || null,
    shipping_provider: "melhor_envio",
    shipping_carrier: shippingResult?.carrier || order?.shipping_carrier || null,
    processed_at: new Date().toISOString()
  };

  if (labelUrl) patch.shipping_label_url = labelUrl;
  if (labelPdfUrl) patch.shipping_label_pdf_url = labelPdfUrl;
  if (trackingCode) patch.shipping_tracking_code = trackingCode;
  if (shipmentId) patch.shipping_shipment_id = shipmentId;
  if (generated) patch.shipping_label_generated_at = new Date().toISOString();

  return updateOrder(order.id, patch);
}

function buildProcessResult({
  order,
  invoiceResult = null,
  shippingResult = null,
  status = "done",
  message = ""
}) {
  return {
    success: status === "done",
    status,
    message,
    orderId: order?.id || null,
    orderNumber: order?.order_number || null,
    invoice: invoiceResult,
    shipping: shippingResult
  };
}

export async function processPaidOrder(input) {
  const orderId =
    typeof input === "string"
      ? input
      : input?.orderId || input?.id || null;

  const orderNumber =
    typeof input === "object"
      ? input?.orderNumber || input?.order_number || null
      : null;

  if (!orderId && !orderNumber) {
    throw new Error("Informe orderId ou orderNumber para processar o pedido pago");
  }

  let order = null;

  if (orderId) {
    order = await findOrderById(orderId);
  } else if (orderNumber) {
    order = await findOrderByNumber(orderNumber);
  }

  if (!order) {
    throw new Error("Pedido não encontrado para processamento");
  }

  const items = await findOrderItems(order.id);

  await appendOrderProcessingEvent(order.id, "process_paid_order_started", {
    status: "started",
    message: "Início do processamento do pedido pago",
    payload: {
      orderId: order.id,
      orderNumber: order.order_number,
      itemsCount: items.length
    }
  });

  const paymentStatus = normalizePaymentStatus(order);

  if (paymentStatus !== "paid" && paymentStatus !== "approved") {
    const error = new Error(
      "O pedido ainda não possui pagamento confirmado. O processamento foi bloqueado."
    );
    error.statusCode = 409;
    throw error;
  }

  const stockReservation = await ensureOrderStockReserved(order.id);

  if (!stockReservation?.reserved) {
    const error = new Error(
      "O pagamento está confirmado, mas o estoque do pedido não pôde ser reservado. Revise o pedido manualmente."
    );
    error.statusCode = 409;
    error.details = stockReservation;
    throw error;
  }

  if (isAlreadyProcessed(order)) {
    await appendOrderProcessingEvent(order.id, "process_paid_order_skipped", {
      status: "skipped",
      message: "Pedido já possui etiqueta gerada"
    });

    return buildProcessResult({
      order,
      status: "done",
      message: "Pedido já estava processado"
    });
  }

  await markOrderAwaitingInvoice(order);

  await appendOrderProcessingEvent(order.id, "awaiting_invoice", {
    status: "awaiting_invoice",
    message: "Pedido aguardando emissão de nota fiscal"
  });

  let invoiceResult = null;

  if (isInvoiceAuthorized(order)) {
    invoiceResult = {
      success: true,
      status: "authorized",
      invoiceKey: order.invoice_key,
      invoiceNumber: order.invoice_number || null,
      invoiceSeries: order.invoice_series || null,
      xmlUrl: order.invoice_xml_url || null,
      pdfUrl: order.invoice_pdf_url || null
    };

    await appendOrderProcessingEvent(order.id, "invoice_reused", {
      status: "authorized",
      message: "Nota fiscal já autorizada, reutilizando dados existentes",
      payload: {
        invoiceKey: order.invoice_key
      }
    });
  } else {
    invoiceResult = await emitInvoiceForOrder(order, items);
  }

  const invoiceFailed = !invoiceResult?.success;

  if (invoiceFailed) {
    await appendOrderProcessingEvent(order.id, "invoice_error_continue_shipping", {
      status: invoiceResult?.status || "invoice_error",
      message:
        invoiceResult?.error ||
        "Etapa fiscal falhou, mas a geração do carrinho Melhor Envio continuará",
      payload: invoiceResult?.raw || null
    });
  } else {
    order = await updateOrderInvoiceFields(order.id, {
      invoice_status: "authorized",
      invoice_key: invoiceResult.invoiceKey || null,
      invoice_number: invoiceResult.invoiceNumber || null,
      invoice_series: invoiceResult.invoiceSeries || null,
      invoice_xml_url: invoiceResult.xmlUrl || null,
      invoice_pdf_url: invoiceResult.pdfUrl || null,
      invoice_error: null,
      invoice_raw: invoiceResult.raw || null,
      invoice_authorized_at: invoiceResult.authorizedAt || new Date().toISOString(),
      processed_at: new Date().toISOString()
    });
  }

  order = await markOrderAwaitingShippingLabel(
    order || { id: orderId },
    invoiceResult
  );

  await appendOrderProcessingEvent(order.id, "awaiting_shipping_label", {
    status: "awaiting_shipping_label",
    message: invoiceFailed
      ? "Etapa fiscal falhou, iniciando geração da etiqueta mesmo assim"
      : "Nota autorizada, iniciando geração da etiqueta",
    payload: invoiceFailed
      ? {
          invoiceStatus: invoiceResult?.status || "invoice_error",
          invoiceError: invoiceResult?.error || null
        }
      : null
  });

  const shippingResult = await generateAutomaticShippingLabel(order, items);

  await saveShippingResult(order, shippingResult);

  if (!shippingResult?.success) {
    await appendOrderProcessingEvent(order.id, "shipping_label_error", {
      status: shippingResult?.labelStatus || "error",
      message: shippingResult?.error || "Erro ao gerar etiqueta",
      payload: shippingResult?.raw || null
    });

    return buildProcessResult({
      order,
      invoiceResult,
      shippingResult,
      status: "shipping_error",
      message: shippingResult?.error || "Erro ao gerar etiqueta"
    });
  }

  await appendOrderProcessingEvent(order.id, "shipping_label_generated", {
    status: "generated",
    message: invoiceFailed
      ? "Etiqueta gerada com sucesso; etapa fiscal segue pendente/erro"
      : "Etiqueta gerada com sucesso",
    payload: {
      trackingCode: shippingResult?.trackingCode || null,
      shipmentId: shippingResult?.shipmentId || null,
      labelUrl: shippingResult?.labelUrl || null,
      invoiceStatus: invoiceResult?.status || null
    }
  });

  return buildProcessResult({
    order,
    invoiceResult,
    shippingResult,
    status: "done",
    message: invoiceFailed
      ? "Pedido processado com etiqueta gerada; etapa fiscal segue pendente/erro"
      : "Pedido processado com sucesso"
  });
}
