import { env } from "../config/env.js";
import { getMercadoPagoPayment } from "../services/mercadoPago.service.js";
import {
  applyMercadoPagoPaymentTransition,
  ensureOrderStockReserved,
} from "../services/orderStock.service.js";
import { processPaidOrder } from "./processPaidOrder.js";

function headers() {
  return {
    apikey: env.supabaseServiceRoleKey,
    Authorization: `Bearer ${env.supabaseServiceRoleKey}`,
    Accept: "application/json",
  };
}

function normalize(value) {
  return String(value || "").trim();
}

function isManagedGateway(value) {
  return normalize(value).toLowerCase().startsWith("mercado_pago");
}

function getFinancialData(payment) {
  const feeDetails = Array.isArray(payment?.fee_details) ? payment.fee_details : [];
  const gatewayFee = feeDetails.reduce((sum, item) => {
    const amount = Number(item?.amount || 0);
    return sum + (Number.isFinite(amount) ? amount : 0);
  }, 0);

  const transactionAmount = Number(payment?.transaction_amount || 0) || 0;
  const netReceivedAmount = Number(payment?.transaction_details?.net_received_amount);
  const netAmount = Number.isFinite(netReceivedAmount)
    ? netReceivedAmount
    : Math.max(0, transactionAmount - gatewayFee);

  return {
    gatewayFee: Number(gatewayFee.toFixed(2)),
    netAmount: Number(netAmount.toFixed(2)),
    paymentMethodId: normalize(payment?.payment_method_id) || null,
    paymentTypeId: normalize(payment?.payment_type_id) || null,
    installments: Number.isFinite(Number(payment?.installments))
      ? Number(payment.installments)
      : null,
  };
}

async function findPendingOrders(limit) {
  const url = new URL(`${env.supabaseUrl}/rest/v1/orders`);
  url.searchParams.set(
    "select",
    "id,order_number,total_amount,payment_reference,payment_external_reference,payment_status,payment_gateway,order_status,created_at"
  );
  url.searchParams.set("payment_status", "eq.pending");
  url.searchParams.set("payment_reference", "not.is.null");
  url.searchParams.set("order", "created_at.asc");
  url.searchParams.set("limit", String(limit));

  const response = await fetch(url, { headers: headers() });
  const data = await response.json().catch(() => []);

  if (!response.ok) {
    throw new Error(data?.message || "Falha ao buscar pagamentos pendentes para conciliação.");
  }

  return Array.isArray(data) ? data.filter((order) => isManagedGateway(order.payment_gateway)) : [];
}

function validatePaymentAgainstOrder(order, payment) {
  const orderNumber = normalize(order?.order_number);
  const externalReference = normalize(payment?.external_reference);
  const metadataOrderId = normalize(payment?.metadata?.order_id);
  const expectedAmount = Number(order?.total_amount || 0);
  const receivedAmount = Number(payment?.transaction_amount || 0);
  const currency = normalize(payment?.currency_id || "BRL").toUpperCase();

  return (
    orderNumber &&
    externalReference === orderNumber &&
    Number.isFinite(expectedAmount) &&
    Number.isFinite(receivedAmount) &&
    Math.abs(expectedAmount - receivedAmount) <= 0.01 &&
    currency === "BRL" &&
    (!metadataOrderId || metadataOrderId === String(order.id))
  );
}

export async function reconcilePendingMercadoPagoPayments({ limit = 30, trigger = "interval" } = {}) {
  const orders = await findPendingOrders(Math.max(1, Number(limit) || 30));
  const result = {
    trigger,
    checked: 0,
    updated: 0,
    approved: 0,
    pending: 0,
    skipped: 0,
    errors: 0,
  };

  for (const order of orders) {
    const paymentId = normalize(order.payment_reference);
    if (!/^\d{1,32}$/.test(paymentId)) {
      result.skipped += 1;
      continue;
    }

    result.checked += 1;

    try {
      const payment = await getMercadoPagoPayment(paymentId);
      if (!validatePaymentAgainstOrder(order, payment)) {
        console.error("MERCADO PAGO AUTO RECONCILE: pagamento divergente; pedido não alterado.", {
          orderId: order.id,
          orderNumber: order.order_number,
          paymentId,
        });
        result.skipped += 1;
        continue;
      }

      const paymentStatus = normalize(payment?.status).toLowerCase();
      if (!paymentStatus) {
        result.skipped += 1;
        continue;
      }

      if (paymentStatus === "approved") {
        const stockReservation = await ensureOrderStockReserved(order.id);
        if (!stockReservation?.reserved) {
          console.error("MERCADO PAGO AUTO RECONCILE: pagamento aprovado sem estoque reservado.", {
            orderId: order.id,
            orderNumber: order.order_number,
            paymentId,
          });
          result.skipped += 1;
          continue;
        }
      }

      const financial = getFinancialData(payment);
      const transition = await applyMercadoPagoPaymentTransition({
        externalReference: order.order_number,
        paymentId,
        rawStatus: paymentStatus,
        gatewayFee: financial.gatewayFee,
        netAmount: financial.netAmount,
        paymentMethodId: financial.paymentMethodId,
        paymentTypeId: financial.paymentTypeId,
        installments: financial.installments,
      });

      if (!transition?.success) {
        result.skipped += 1;
        continue;
      }

      if (transition?.claimed) {
        result.updated += 1;
      }

      if (paymentStatus === "approved") {
        result.approved += 1;
        if (transition?.order?.id) {
          try {
            await processPaidOrder({ orderId: transition.order.id });
          } catch (postPaymentError) {
            console.error("MERCADO PAGO AUTO RECONCILE: falha no pós-pagamento.", {
              orderId: transition.order.id,
              message: postPaymentError?.message || String(postPaymentError),
            });
          }
        }
      } else if (["pending", "in_process", "in_mediation"].includes(paymentStatus)) {
        result.pending += 1;
      }
    } catch (error) {
      result.errors += 1;
      console.error("MERCADO PAGO AUTO RECONCILE ERROR:", {
        orderId: order.id,
        orderNumber: order.order_number,
        paymentId,
        message: error?.message || String(error),
      });
    }
  }

  return result;
}
