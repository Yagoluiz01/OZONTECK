import { env } from "../config/env.js";

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

  if (isAlreadyReleased(conversion.status)) {
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

  return {
    updated: result.success,
    skipped: false,
    action: "released_after_delivery",
    conversionId: conversion.id,
    status: result.result?.status || null,
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
      metadata,
      notes: `${conversion.notes || ""}\nComissão cancelada automaticamente porque o pedido foi cancelado.`.trim(),
    },
    {
      status: "rejected",
      metadata,
      notes: `${conversion.notes || ""}\nComissão rejeitada automaticamente porque o pedido foi cancelado.`.trim(),
    },
    {
      status: "failed",
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
  const trackingStatus = normalizeStatus(order.shipping_label_raw?.sync_tracking_status);

  const shouldCancel = isCancelledLikeStatus(orderStatus);
  const shouldRelease = isDeliveredLikeStatus(orderStatus) || isDeliveredLikeStatus(trackingStatus);

  if (!shouldRelease && !shouldCancel) {
    return {
      success: true,
      skipped: true,
      reason: "status_without_lifecycle_action",
      orderId: order.id,
      orderStatus: order.order_status || null,
      syncTrackingStatus: order.shipping_label_raw?.sync_tracking_status || null,
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
    syncTrackingStatus: order.shipping_label_raw?.sync_tracking_status || null,
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
