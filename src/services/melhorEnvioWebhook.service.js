import crypto from "crypto";
import { supabaseAdmin } from "../config/supabase.js";
import { createAdminNotification } from "./adminNotifications.service.js";
import { syncAffiliateCommissionLifecycleForOrder } from "./affiliateCommissionLifecycle.service.js";

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizeStatus(value) {
  return normalizeString(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function getWebhookSecret() {
  const secret = normalizeString(
    process.env.MELHOR_ENVIO_WEBHOOK_SECRET || process.env.MELHOR_ENVIO_CLIENT_SECRET
  );

  if (!secret) {
    const error = new Error(
      "MELHOR_ENVIO_WEBHOOK_SECRET ausente. Configure o secret do aplicativo Melhor Envio no Render."
    );
    error.statusCode = 500;
    throw error;
  }

  return secret;
}

function normalizeReceivedSignature(value) {
  return normalizeString(value)
    .replace(/^sha256=/i, "")
    .replace(/^hmac-sha256=/i, "");
}

function timingSafeStringEqual(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));

  if (left.length !== right.length) {
    return false;
  }

  return crypto.timingSafeEqual(left, right);
}

export function verifyMelhorEnvioWebhookSignature({ rawBody, signature }) {
  const receivedSignature = normalizeReceivedSignature(signature);

  if (!receivedSignature) {
    const error = new Error("Assinatura X-ME-Signature não enviada.");
    error.statusCode = 401;
    throw error;
  }

  const secret = getWebhookSecret();
  const bodyBuffer = Buffer.isBuffer(rawBody)
    ? rawBody
    : Buffer.from(String(rawBody || ""), "utf8");

  const digest = crypto.createHmac("sha256", secret).update(bodyBuffer).digest();
  const expectedBase64 = digest.toString("base64");
  const expectedHex = digest.toString("hex");

  const isValid =
    timingSafeStringEqual(receivedSignature, expectedBase64) ||
    timingSafeStringEqual(receivedSignature, expectedHex);

  if (!isValid) {
    const error = new Error("Assinatura do webhook Melhor Envio inválida.");
    error.statusCode = 401;
    throw error;
  }

  return true;
}

function collectWebhookIdentifiers(payload = {}) {
  const data = safeObject(payload.data);
  const identifiers = [];

  const add = (field, value, label) => {
    const cleanValue = normalizeString(value);
    if (!cleanValue) return;

    const key = `${field}:${cleanValue}`;
    if (identifiers.some((item) => item.key === key)) return;

    identifiers.push({ field, value: cleanValue, label, key });
  };

  add("shipping_shipment_id", data.id, "data.id");
  add("shipping_shipment_id", data.protocol, "data.protocol");
  add("shipping_tracking_code", data.tracking, "data.tracking");
  add("tracking_code", data.tracking, "data.tracking");
  add("shipping_tracking_code", data.self_tracking, "data.self_tracking");
  add("tracking_code", data.self_tracking, "data.self_tracking");

  if (Array.isArray(data.tags)) {
    for (const tagItem of data.tags) {
      const tagValue = normalizeString(tagItem?.tag || tagItem?.value || tagItem?.name);
      const orderMatch = tagValue.match(/(?:pedido|order)\s*#?:?\s*([A-Za-z0-9._-]+)/i);
      if (orderMatch?.[1]) {
        add("order_number", orderMatch[1], "data.tags.order_number");
      }
    }
  }

  return identifiers;
}

async function fetchOrderByColumn(field, value) {
  const { data, error } = await supabaseAdmin
    .from("orders")
    .select("*")
    .eq(field, value)
    .order("created_at", { ascending: false })
    .limit(1);

  if (error) {
    console.warn("[MELHOR_ENVIO_WEBHOOK_FIND_ORDER_COLUMN_ERROR]", {
      field,
      value,
      message: error.message,
    });
    return null;
  }

  return Array.isArray(data) ? data[0] || null : null;
}

async function fetchOrderByRawContains(patch = {}, label = "shipping_label_raw") {
  const { data, error } = await supabaseAdmin
    .from("orders")
    .select("*")
    .contains("shipping_label_raw", patch)
    .order("created_at", { ascending: false })
    .limit(1);

  if (error) {
    console.warn("[MELHOR_ENVIO_WEBHOOK_FIND_ORDER_RAW_ERROR]", {
      label,
      patch,
      message: error.message,
    });
    return null;
  }

  return Array.isArray(data) ? data[0] || null : null;
}

async function findOrderForMelhorEnvioWebhook(payload = {}) {
  const identifiers = collectWebhookIdentifiers(payload);

  for (const identifier of identifiers) {
    const order = await fetchOrderByColumn(identifier.field, identifier.value);
    if (order?.id) {
      return {
        order,
        matchedBy: identifier.label,
        matchedField: identifier.field,
        matchedValue: identifier.value,
      };
    }
  }

  const data = safeObject(payload.data);
  const shipmentId = normalizeString(data.id);
  const protocol = normalizeString(data.protocol);

  if (shipmentId) {
    const order = await fetchOrderByRawContains({ cartId: shipmentId }, "cartId");
    if (order?.id) {
      return {
        order,
        matchedBy: "shipping_label_raw.cartId",
        matchedField: "shipping_label_raw",
        matchedValue: shipmentId,
      };
    }
  }

  if (protocol) {
    const order = await fetchOrderByRawContains({ cartProtocol: protocol }, "cartProtocol");
    if (order?.id) {
      return {
        order,
        matchedBy: "shipping_label_raw.cartProtocol",
        matchedField: "shipping_label_raw",
        matchedValue: protocol,
      };
    }
  }

  return {
    order: null,
    matchedBy: null,
    matchedField: null,
    matchedValue: null,
  };
}

function isDeliveredWebhook(payload = {}) {
  const event = normalizeStatus(payload.event || payload.topic || payload.type);
  const status = normalizeStatus(payload.data?.status);

  return event === "order.delivered" || status === "delivered" || status === "entregue";
}

function isCancelledWebhook(payload = {}) {
  const event = normalizeStatus(payload.event || payload.topic || payload.type);
  const status = normalizeStatus(payload.data?.status);

  return (
    event === "order.cancelled" ||
    event === "order.canceled" ||
    ["cancelled", "canceled", "cancelado", "cancelada"].includes(status)
  );
}

function buildRawPatch(order = {}, payload = {}, meta = {}) {
  return {
    ...safeObject(order.shipping_label_raw),
    melhor_envio_webhook_received_at: new Date().toISOString(),
    melhor_envio_webhook_event: payload.event || payload.topic || payload.type || "",
    melhor_envio_webhook_data: safeObject(payload.data),
    melhor_envio_webhook_matched_by: meta.matchedBy || "",
  };
}

async function patchOrderWithFallbacks(orderId, payloads = []) {
  let lastError = null;

  for (const payload of payloads) {
    const { data, error } = await supabaseAdmin
      .from("orders")
      .update(payload)
      .eq("id", orderId)
      .select("*")
      .single();

    if (!error) {
      return data;
    }

    lastError = error;
    console.warn("[MELHOR_ENVIO_WEBHOOK_ORDER_PATCH_FALLBACK]", {
      orderId,
      payloadKeys: Object.keys(payload || {}),
      message: error.message,
    });
  }

  throw new Error(lastError?.message || "Erro ao atualizar pedido pelo webhook Melhor Envio.");
}

async function markOrderAsDeliveredFromWebhook(order, payload, meta = {}) {
  const data = safeObject(payload.data);
  const now = new Date().toISOString();
  const deliveredAt = normalizeString(data.delivered_at) || order.delivered_at || now;
  const trackingCode = normalizeString(data.tracking || data.self_tracking);
  const rawPatch = buildRawPatch(order, payload, meta);

  const basePayload = {
    order_status: "delivered",
    delivered_at: deliveredAt,
    shipped_at: order.shipped_at || normalizeString(data.posted_at) || deliveredAt,
    shipping_label_raw: rawPatch,
  };

  if (trackingCode) {
    basePayload.shipping_tracking_code = trackingCode;
    basePayload.tracking_code = trackingCode;
  }

  const fullPayload = {
    ...basePayload,
    delivery_status: "delivered",
    tracking_status: "delivered",
  };

  return patchOrderWithFallbacks(order.id, [fullPayload, basePayload]);
}

async function markOrderAsCancelledFromWebhook(order, payload, meta = {}) {
  const data = safeObject(payload.data);
  const rawPatch = buildRawPatch(order, payload, meta);

  const basePayload = {
    order_status: "cancelled",
    shipping_label_error: "Etiqueta cancelada pelo Melhor Envio.",
    shipping_label_raw: rawPatch,
  };

  const fullPayload = {
    ...basePayload,
    delivery_status: "cancelled",
    tracking_status: "cancelled",
    cancelled_at: normalizeString(data.canceled_at || data.cancelled_at) || undefined,
  };

  Object.keys(fullPayload).forEach((key) => {
    if (typeof fullPayload[key] === "undefined") {
      delete fullPayload[key];
    }
  });

  return patchOrderWithFallbacks(order.id, [fullPayload, basePayload]);
}

async function notifyDeliveredWebhookOrderNotFound(payload = {}) {
  const data = safeObject(payload.data);

  return createAdminNotification({
    type: "melhor_envio_webhook_order_not_found",
    title: "Webhook Melhor Envio sem pedido encontrado",
    message:
      `A Melhor Envio informou entrega, mas nenhum pedido foi encontrado. ` +
      `Envio: ${data.id || "sem id"}. Protocolo: ${data.protocol || "sem protocolo"}.`,
    entity_type: "shipping_webhook",
    entity_id: normalizeString(data.id) || null,
    priority: "high",
    metadata: {
      event: payload.event || payload.topic || payload.type || "",
      shipment_id: data.id || null,
      protocol: data.protocol || null,
      status: data.status || null,
      tracking: data.tracking || null,
      payload,
    },
  }).catch((error) => {
    console.error("[MELHOR_ENVIO_WEBHOOK_ORDER_NOT_FOUND_NOTIFICATION_ERROR]", error);
    return null;
  });
}

export async function handleMelhorEnvioWebhook({ payload, rawBody, signature }) {
  verifyMelhorEnvioWebhookSignature({ rawBody, signature });

  const event = normalizeString(payload?.event || payload?.topic || payload?.type);
  const delivered = isDeliveredWebhook(payload);
  const cancelled = isCancelledWebhook(payload);

  if (!delivered && !cancelled) {
    return {
      success: true,
      received: true,
      skipped: true,
      reason: "event_without_order_lifecycle_action",
      event,
      status: payload?.data?.status || null,
    };
  }

  const match = await findOrderForMelhorEnvioWebhook(payload);

  if (!match.order?.id) {
    if (delivered) {
      await notifyDeliveredWebhookOrderNotFound(payload);
    }

    return {
      success: true,
      received: true,
      skipped: true,
      reason: "order_not_found_for_webhook",
      event,
      shipmentId: payload?.data?.id || null,
      protocol: payload?.data?.protocol || null,
      tracking: payload?.data?.tracking || null,
    };
  }

  const updatedOrder = delivered
    ? await markOrderAsDeliveredFromWebhook(match.order, payload, match)
    : await markOrderAsCancelledFromWebhook(match.order, payload, match);

  const lifecycleResult = await syncAffiliateCommissionLifecycleForOrder(
    updatedOrder,
    delivered ? "melhor_envio_webhook_order_delivered" : "melhor_envio_webhook_order_cancelled"
  );

  return {
    success: true,
    received: true,
    skipped: false,
    action: delivered ? "order_delivered" : "order_cancelled",
    event,
    orderId: updatedOrder.id,
    orderNumber: updatedOrder.order_number || null,
    matchedBy: match.matchedBy,
    matchedField: match.matchedField,
    matchedValue: match.matchedValue,
    lifecycleResult,
  };
}
