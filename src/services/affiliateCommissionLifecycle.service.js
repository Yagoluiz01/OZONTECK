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
  const id = String(orderId || "").trim();

  if (!id) {
    return {
      ok: false,
      status: 400,
      data: [],
      error: "order_id_missing",
    };
  }

  const url = new URL(`${env.supabaseUrl}/rest/v1/affiliate_conversions`);
  url.searchParams.set(
    "select",
    "id,affiliate_id,order_id,commission_amount,conversion_type,status,released_at,metadata,notes"
  );
  url.searchParams.set("order_id", `eq.${id}`);

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: getHeaders(),
  });

  const data = await response.json().catch(() => []);

  return {
    ok: response.ok,
    status: response.status,
    data: Array.isArray(data) ? data : [],
    error: response.ok ? null : data,
  };
}

async function patchAffiliateConversion(conversionId, payload) {
  const id = String(conversionId || "").trim();

  if (!id) {
    return {
      ok: false,
      status: 400,
      data: [],
      error: "conversion_id_missing",
    };
  }

  const url = new URL(`${env.supabaseUrl}/rest/v1/affiliate_conversions`);
  url.searchParams.set("id", `eq.${id}`);
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
    error: response.ok ? null : data,
  };
}

async function patchWithStatusFallback(conversion, statusCandidates, basePayload) {
  let lastResult = null;

  for (const status of statusCandidates) {
    const result = await patchAffiliateConversion(conversion.id, {
      ...basePayload,
      status,
    });

    if (result.ok) {
      return {
        ...result,
        usedStatus: status,
        usedFallback: status !== statusCandidates[0],
      };
    }

    lastResult = result;
  }

  const metadataOnlyResult = await patchAffiliateConversion(conversion.id, basePayload);

  return {
    ...metadataOnlyResult,
    usedStatus: null,
    usedFallback: true,
    statusPatchError: lastResult?.error || null,
  };
}

async function releaseConversionsForDeliveredOrder(order, conversions, source) {
  const now = new Date().toISOString();
  const results = [];

  for (const conversion of conversions) {
    const currentStatus = normalizeStatus(conversion.status);

    if (isAlreadyReleased(currentStatus)) {
      results.push({
        conversionId: conversion.id,
        action: "skipped",
        reason: "already_released_or_paid",
        status: conversion.status || null,
      });
      continue;
    }

    const metadata = {
      ...safeMetadata(conversion.metadata),
      commission_lifecycle: {
        source,
        action: "released_after_delivery",
        order_id: order.id,
        order_number: order.order_number || null,
        released_at: now,
      },
    };

    const noteSuffix = `Comissão liberada automaticamente após entrega do pedido ${order.order_number || order.id}.`;
    const notes = String(conversion.notes || "").includes(noteSuffix)
      ? conversion.notes
      : [conversion.notes, noteSuffix].filter(Boolean).join("\n");

    const result = await patchWithStatusFallback(
      conversion,
      ["released", "approved"],
      {
        released_at: now,
        metadata,
        notes,
      }
    );

    results.push({
      conversionId: conversion.id,
      action: result.ok ? "released" : "error",
      ok: result.ok,
      usedStatus: result.usedStatus,
      usedFallback: Boolean(result.usedFallback),
      error: result.ok ? null : result.error,
    });
  }

  return results;
}

async function cancelConversionsForCancelledOrder(order, conversions, source) {
  const now = new Date().toISOString();
  const results = [];

  for (const conversion of conversions) {
    const currentStatus = normalizeStatus(conversion.status);

    if (["cancelled", "canceled", "cancelado", "rejected", "failed"].includes(currentStatus)) {
      results.push({
        conversionId: conversion.id,
        action: "skipped",
        reason: "already_cancelled",
        status: conversion.status || null,
      });
      continue;
    }

    if (["paid", "pago"].includes(currentStatus)) {
      results.push({
        conversionId: conversion.id,
        action: "skipped",
        reason: "already_paid_not_cancelled_automatically",
        status: conversion.status || null,
      });
      continue;
    }

    const metadata = {
      ...safeMetadata(conversion.metadata),
      commission_lifecycle: {
        source,
        action: "cancelled_after_order_cancelled",
        order_id: order.id,
        order_number: order.order_number || null,
        cancelled_at: now,
      },
    };

    const noteSuffix = `Comissão cancelada automaticamente porque o pedido ${order.order_number || order.id} foi cancelado.`;
    const notes = String(conversion.notes || "").includes(noteSuffix)
      ? conversion.notes
      : [conversion.notes, noteSuffix].filter(Boolean).join("\n");

    const result = await patchWithStatusFallback(
      conversion,
      ["cancelled", "rejected", "failed"],
      {
        released_at: null,
        metadata,
        notes,
      }
    );

    results.push({
      conversionId: conversion.id,
      action: result.ok ? "cancelled" : "error",
      ok: result.ok,
      usedStatus: result.usedStatus,
      usedFallback: Boolean(result.usedFallback),
      error: result.ok ? null : result.error,
    });
  }

  return results;
}

export async function syncAffiliateCommissionLifecycleForOrder(
  order,
  { source = "order_lifecycle" } = {}
) {
  try {
    if (!order?.id) {
      return {
        success: false,
        skipped: true,
        reason: "missing_order",
      };
    }

    const orderStatus = normalizeStatus(order.order_status || order.status);
    const paymentStatus = normalizeStatus(order.payment_status || order.payment_raw_status);
    const hasDeliveredAt = Boolean(order.delivered_at);

    const shouldRelease =
      isDeliveredLikeStatus(orderStatus) ||
      isDeliveredLikeStatus(order.delivery_status) ||
      hasDeliveredAt;

    const shouldCancel =
      isCancelledLikeStatus(orderStatus) ||
      isCancelledLikeStatus(paymentStatus);

    if (!shouldRelease && !shouldCancel) {
      return {
        success: true,
        skipped: true,
        reason: "order_status_without_commission_lifecycle_change",
        orderStatus,
        paymentStatus,
      };
    }

    const conversionsResponse = await fetchAffiliateConversionsByOrderId(order.id);

    if (!conversionsResponse.ok) {
      return {
        success: false,
        skipped: false,
        reason: "affiliate_conversions_fetch_failed",
        error: conversionsResponse.error,
      };
    }

    const conversions = conversionsResponse.data;

    if (!conversions.length) {
      return {
        success: true,
        skipped: true,
        reason: "no_affiliate_conversions_for_order",
        orderId: order.id,
      };
    }

    const actionResults = shouldCancel
      ? await cancelConversionsForCancelledOrder(order, conversions, source)
      : await releaseConversionsForDeliveredOrder(order, conversions, source);

    const failed = actionResults.filter((item) => item.action === "error");

    return {
      success: failed.length === 0,
      skipped: false,
      action: shouldCancel ? "cancelled" : "released",
      orderId: order.id,
      orderNumber: order.order_number || null,
      checked: conversions.length,
      updated: actionResults.filter((item) => item.ok).length,
      failed: failed.length,
      results: actionResults,
    };
  } catch (error) {
    console.error("ERRO NO CICLO DE COMISSÃO DO AFILIADO:", error);

    return {
      success: false,
      skipped: false,
      reason: "unexpected_affiliate_commission_lifecycle_error",
      error: error?.message || String(error),
    };
  }
}
