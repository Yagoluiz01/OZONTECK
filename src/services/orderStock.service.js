import { env } from "../config/env.js";

function getHeaders() {
  return {
    apikey: env.supabaseServiceRoleKey,
    Authorization: `Bearer ${env.supabaseServiceRoleKey}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

async function callRpc(name, payload) {
  const response = await fetch(`${env.supabaseUrl}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify(payload || {}),
  });

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    const error = new Error(
      data?.message || data?.details || data?.hint || `Erro na operação ${name}.`
    );
    error.statusCode = response.status === 404 ? 503 : response.status;
    error.details = data;
    throw error;
  }

  return data;
}

export async function createStoreOrderAtomic(order, items) {
  return callRpc("create_store_order_atomic", {
    p_order: order,
    p_items: items,
  });
}

export async function releaseOrderStock(orderId, reason = "cancelled") {
  return callRpc("release_order_stock", {
    p_order_id: orderId,
    p_reason: reason,
  });
}

export async function ensureOrderStockReserved(orderId) {
  return callRpc("ensure_order_stock_reserved", {
    p_order_id: orderId,
  });
}

export async function releaseExpiredOrderStockReservations(limit = 100) {
  return callRpc("release_expired_order_stock_reservations", {
    p_limit: limit,
  });
}


export async function claimOrderShippingLabelGeneration(orderId) {
  return callRpc("claim_order_shipping_label_generation", {
    p_order_id: orderId,
  });
}

export async function applyMercadoPagoPaymentTransition({
  externalReference,
  paymentId,
  rawStatus,
  gatewayFee = 0,
  netAmount = 0,
  paymentMethodId = null,
  paymentTypeId = null,
  installments = null,
}) {
  return callRpc("apply_mercado_pago_payment_transition", {
    p_external_reference: externalReference,
    p_payment_id: String(paymentId || ""),
    p_raw_status: rawStatus,
    p_gateway_fee: gatewayFee,
    p_net_amount: netAmount,
    p_payment_method_id: paymentMethodId,
    p_payment_type_id: paymentTypeId,
    p_installments: installments,
  });
}
