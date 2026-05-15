import { MercadoPagoConfig, Preference, Payment } from "mercadopago";
import { env } from "../config/env.js";

function getMercadoPagoClient() {
  if (!env.mercadoPagoAccessToken) {
    throw new Error("MERCADO_PAGO_ACCESS_TOKEN não configurado.");
  }

  return new MercadoPagoConfig({
    accessToken: env.mercadoPagoAccessToken,
  });
}

export async function createMercadoPagoPreference(order) {
  const client = getMercadoPagoClient();
  const preferenceClient = new Preference(client);

  const items = Array.isArray(order.items)
    ? order.items.map((item) => ({
        id: String(item.product_id || item.id || ""),
        title: String(item.name || item.product_name || "Produto OZONTECK"),
        quantity: Number(item.quantity || 1),
        unit_price: Number(item.unit_price || item.price || 0),
        currency_id: "BRL",
      }))
    : [];

  if (!items.length) {
    throw new Error("Pedido sem itens para criar pagamento no Mercado Pago.");
  }

  const preference = await preferenceClient.create({
    body: {
      items,

      external_reference: String(order.order_number || order.orderNumber),

      payer: {
        name: order.customer_name || order.customerName || "",
        email: order.customer_email || order.customerEmail || "",
      },

      back_urls: {
        success: env.storeSuccessUrl,
        pending: env.storePendingUrl,
        failure: env.storeFailureUrl,
      },

      auto_return: "approved",

      notification_url: `${env.apiBaseUrl}/api/store/payments/mercado-pago/webhook`,

      metadata: {
        order_number: String(order.order_number || order.orderNumber),
      },
    },
  });

  return preference;
}

export async function getMercadoPagoPayment(paymentId) {
  const client = getMercadoPagoClient();
  const paymentClient = new Payment(client);

  return paymentClient.get({
    id: paymentId,
  });
}