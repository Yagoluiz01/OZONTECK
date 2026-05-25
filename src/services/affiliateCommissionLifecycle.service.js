import { env } from "../config/env.js";
import { createAdminNotification } from "./adminNotifications.service.js";

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

function isAlreadyReleased(value) {
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

function safeMetadata(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value;
  }

  return {};
}

function formatMoneyBR(value) {
  const number = Number(value || 0);

  return number.toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

function getCommissionAmount(conversion = {}) {
  return Number(
    conversion.commission_amount ||
      conversion.recruitment_bonus_amount ||
      conversion.network_commission ||
      0
  );
}

function wasAlreadyReleasedByDelivery(conversion = {}) {
  const metadata = safeMetadata(conversion.metadata);
  const status = normalizeStatus(conversion.status);

  if (["paid", "pago"].includes(status)) {
    return true;
  }

  return Boolean(conversion.released_at && metadata.released_by_delivery);
}

function getAffiliateLabel(conversion = {}) {
  return (
    conversion.affiliate_name ||
    conversion.full_name ||
    conversion.affiliate_email ||
    conversion.email ||
    conversion.ref_code ||
    conversion.affiliate_id ||
    "Afiliado"
  );
}

async function notifyAdminCommissionReadyToPay(conversion = {}, order = {}, source = "") {
  try {
    const amount = getCommissionAmount(conversion);
    const amountLabel = formatMoneyBR(amount);
    const orderNumber = order?.order_number || order?.id || conversion.order_id || "sem número";
    const affiliateLabel = getAffiliateLabel(conversion);

    return await createAdminNotification({
      type: "affiliate_commission_ready_to_pay",
      title: "Comissão liberada para pagamento",
      message: `Pedido ${orderNumber} foi entregue. ${affiliateLabel} tem ${amountLabel} liberado para pagamento.`,
      entity_type: "affiliate_conversion",
      entity_id: conversion.id || null,
      priority: "high",
      metadata: {
        affiliate_id: conversion.affiliate_id || null,
        affiliate_label: affiliateLabel,
        conversion_id: conversion.id || null,
        conversion_type: conversion.conversion_type || "",
        order_id: order?.id || conversion.order_id || null,
        order_number: orderNumber,
        commission_amount: amount,
        commission_amount_label: amountLabel,
        order_status: order?.order_status || "",
        delivered_at: order?.delivered_at || "",
        source,
      },
    });
  } catch (error) {
    console.error("AFFILIATE COMMISSION READY NOTIFICATION ERROR:", {
      conversionId: conversion?.id || null,
      affiliateId: conversion?.affiliate_id || null,
      orderId: order?.id || conversion?.order_id || null,
      orderNumber: order?.order_number || null,
      message: error?.message || String(error),
    });

    return null;
  }
}

async function fetchAffiliateConversionsByOrderId(orderId) {
  const cleanOrderId = String(orderId || "").trim();

  if (!cleanOrderId) {
    return [];
  }

  const url = new URL(`${env.supabaseUrl}/rest/v1/affiliate_conversions`);
  url.searchParams.set("select", "*");
  url.searchParams.set("order_id", `eq.${cleanOrderId}`);

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: getHeaders(),
  });

  const data = await response.json().catch(() => []);

  if (!response.ok) {
    console.error("AFFILIATE COMMISSION LIFECYCLE FETCH ERROR:", {
      orderId: cleanOrderId,
      status: response.status,
      data,
    });

    return [];
  }

  return Array.isArray(data) ? data : [];
}

async function patchAffiliateConversion(conversionId, payload) {
  const url = new URL(`${env.supabaseUrl}/rest/v1/affiliate_conversions`);
  url.searchParams.set("id", `eq.${conversionId}`);
  url.searchParams.set("select", "*");

  const response = await fetch(url.toString(), {
    method: "PATCH",
    headers: {
      ...getHeaders(),
      Prefer: "return=representation",
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json().catch(() => []);

  return {
    ok: response.ok,
    status: response.status,
    data: Array.isArray(data) ? data : [],
    raw: data,
  };
}

async function tryPatchAffiliateConversion(conversionId, payloads = []) {
  let lastResult = null;

  for (const payload of payloads) {
    const result = await patchAffiliateConversion(conversionId, payload);
    lastResult = result;

    if (result.ok) {
      return {
        success: true,
        payload,
        result,
      };
    }

    console.warn("AFFILIATE COMMISSION LIFECYCLE PATCH FALLBACK:", {
      conversionId,
      status: result.status,
      payload,
      data: result.raw,
    });
  }

  return {
    success: false,
    payload: null,
    result: lastResult,
  };
}

async function releaseAffiliateConversion(conversion, order, source) {
  if (!conversion?.id) {
    return {
      updated: false,
      skipped: true,
      reason: "missing_conversion_id",
    };
  }

  if (wasAlreadyReleasedByDelivery(conversion)) {
    return {
      updated: false,
      skipped: true,
      reason: "already_released",
      conversionId: conversion.id,
    };
  }

  const now = new Date().toISOString();
  const metadata = {
    ...safeMetadata(conversion.metadata),
    released_by_delivery: true,
    released_by_delivery_source: source,
    released_by_delivery_at: now,
    released_order_id: order?.id || null,
    released_order_number: order?.order_number || null,
    released_order_status: order?.order_status || null,
    released_tracking_status: order?.shipping_label_raw?.sync_tracking_status || null,
  };

  const payloads = [
    {
      status: "released",
      released_at: now,
      metadata,
      notes: `${conversion.notes || ""}\nComissão liberada automaticamente após confirmação de entrega ao cliente final.`.trim(),
    },
    {
      status: "approved",
      released_at: now,
      metadata,
      notes: `${conversion.notes || ""}\nComissão liberada automaticamente após confirmação de entrega ao cliente final.`.trim(),
    },
  ];

  const result = await tryPatchAffiliateConversion(conversion.id, payloads);
  const updatedConversion = result.result?.data?.[0] || {
    ...conversion,
    ...(result.payload || {}),
  };

  const notification = result.success
    ? await notifyAdminCommissionReadyToPay(updatedConversion, order, source)
    : null;

  return {
    updated: result.success,
    skipped: false,
    action: "released_after_delivery",
    conversionId: conversion.id,
    status: updatedConversion?.status || result.result?.status || null,
    notificationCreated: Boolean(notification?.success || notification?.notification?.id),
    details: result.result?.raw || null,
  };
}

async function cancelAffiliateConversion(conversion, order, source) {
  if (!conversion?.id) {
    return {
      updated: false,
      skipped: true,
      reason: "missing_conversion_id",
    };
  }

  const normalized = normalizeStatus(conversion.status);

  if (["cancelled", "canceled", "cancelado", "rejected", "failed"].includes(normalized)) {
    return {
      updated: false,
      skipped: true,
      reason: "already_cancelled",
      conversionId: conversion.id,
    };
  }

  const now = new Date().toISOString();
  const metadata = {
    ...safeMetadata(conversion.metadata),
    cancelled_by_order_status: true,
    cancelled_by_order_status_source: source,
    cancelled_by_order_status_at: now,
    cancelled_order_id: order?.id || null,
    cancelled_order_number: order?.order_number || null,
    cancelled_order_status: order?.order_status || null,
  };

  const payloads = [
    {
      status: "cancelled",
      released_at: null,
      metadata,
      notes: `${conversion.notes || ""}\nComissão cancelada automaticamente porque o pedido foi cancelado.`.trim(),
    },
    {
      status: "rejected",
      released_at: null,
      metadata,
      notes: `${conversion.notes || ""}\nComissão rejeitada automaticamente porque o pedido foi cancelado.`.trim(),
    },
    {
      status: "failed",
      released_at: null,
      metadata,
      notes: `${conversion.notes || ""}\nComissão invalidada automaticamente porque o pedido foi cancelado.`.trim(),
    },
  ];

  const result = await tryPatchAffiliateConversion(conversion.id, payloads);

  return {
    updated: result.success,
    skipped: false,
    action: "cancelled",
    conversionId: conversion.id,
    status: result.result?.status || null,
    details: result.result?.raw || null,
  };
}

export async function syncAffiliateCommissionLifecycleForOrder(order, source = "order_status_update") {
  if (!order?.id) {
    return {
      success: false,
      skipped: true,
      reason: "missing_order",
    };
  }

  const orderStatus = normalizeStatus(order.order_status);
  const paymentStatus = normalizeStatus(order.payment_status);
  const paymentRawStatus = normalizeStatus(order.payment_raw_status);
  const shippingStatus = normalizeStatus(order.shipping_status);
  const deliveryStatus = normalizeStatus(order.delivery_status);
  const trackingStatus = normalizeStatus(
    order.tracking_status || order.shipping_label_raw?.sync_tracking_status
  );

  const hasDeliveredAt = Boolean(order.delivered_at);

  const shouldCancel =
    isCancelledLikeStatus(orderStatus) ||
    isCancelledLikeStatus(paymentStatus) ||
    isCancelledLikeStatus(paymentRawStatus);

  const shouldRelease =
    isDeliveredLikeStatus(orderStatus) ||
    isDeliveredLikeStatus(shippingStatus) ||
    isDeliveredLikeStatus(deliveryStatus) ||
    isDeliveredLikeStatus(trackingStatus) ||
    hasDeliveredAt;

  if (!shouldRelease && !shouldCancel) {
    return {
      success: true,
      skipped: true,
      reason: "status_without_lifecycle_action",
      orderId: order.id,
      orderStatus: order.order_status || null,
      syncTrackingStatus: order.tracking_status || order.shipping_label_raw?.sync_tracking_status || null,
      deliveredAt: order.delivered_at || null,
    };
  }

  const conversions = await fetchAffiliateConversionsByOrderId(order.id);

  if (!conversions.length) {
    return {
      success: true,
      skipped: true,
      reason: "no_affiliate_conversions_for_order",
      orderId: order.id,
      action: shouldCancel ? "cancel" : "release_after_delivery",
    };
  }

  const results = [];

  for (const conversion of conversions) {
    if (shouldCancel) {
      results.push(await cancelAffiliateConversion(conversion, order, source));
      continue;
    }

    results.push(await releaseAffiliateConversion(conversion, order, source));
  }

  const updated = results.filter((item) => item.updated).length;

  console.log("AFFILIATE COMMISSION LIFECYCLE RESULT:", {
    orderId: order.id,
    orderNumber: order.order_number || null,
    orderStatus: order.order_status || null,
    syncTrackingStatus: order.tracking_status || order.shipping_label_raw?.sync_tracking_status || null,
    deliveredAt: order.delivered_at || null,
    source,
    updated,
    checked: conversions.length,
    results,
  });

  return {
    success: true,
    skipped: false,
    orderId: order.id,
    action: shouldCancel ? "cancel" : "release_after_delivery",
    checked: conversions.length,
    updated,
    results,
  };
}
