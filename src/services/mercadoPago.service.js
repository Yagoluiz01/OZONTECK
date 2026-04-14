const crypto = require('crypto');
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');

const client = new MercadoPagoConfig({
  accessToken: process.env.MERCADO_PAGO_ACCESS_TOKEN,
});

const preferenceClient = new Preference(client);
const paymentClient = new Payment(client);

function buildOrderItemsForPreference(order, items = []) {
  return items.map((item) => ({
    id: String(item.product_id || item.id || ''),
    title: item.product_name || item.name || 'Produto OZONTECK',
    quantity: Number(item.quantity || 1),
    unit_price: Number(item.unit_price || item.price || 0),
    currency_id: 'BRL',
  }));
}

async function createCheckoutPreference({ order, items }) {
  const externalReference = order.order_number;

  const body = {
    items: buildOrderItemsForPreference(order, items),
    external_reference: externalReference,
    notification_url: `${process.env.API_BASE_URL}/api/store/payments/mercado-pago/webhook`,
    back_urls: {
      success: process.env.STORE_SUCCESS_URL,
      pending: process.env.STORE_PENDING_URL,
      failure: process.env.STORE_FAILURE_URL,
    },
    auto_return: 'approved',
    payer: {
      name: order.customer_name || undefined,
      email: order.customer_email || undefined,
      phone: order.customer_phone
        ? {
            number: String(order.customer_phone).replace(/\D/g, ''),
          }
        : undefined,
    },
    metadata: {
      order_id: order.id,
      order_number: order.order_number,
    },
  };

  const response = await preferenceClient.create({ body });

  return {
    preferenceId: response.id,
    initPoint: response.init_point,
    sandboxInitPoint: response.sandbox_init_point,
    externalReference,
    raw: response,
  };
}

async function getPaymentById(paymentId) {
  const payment = await paymentClient.get({ id: paymentId });
  return payment;
}

function parseXSignature(signatureHeader = '') {
  const parts = signatureHeader.split(',').map((p) => p.trim());
  const map = {};

  for (const part of parts) {
    const [key, value] = part.split('=');
    if (key && value) map[key] = value;
  }

  return {
    ts: map.ts,
    v1: map.v1,
  };
}

function validateMercadoPagoWebhookSignature({
  xSignature,
  xRequestId,
  dataId,
  secret,
}) {
  if (!xSignature || !xRequestId || !dataId || !secret) return false;

  const { ts, v1 } = parseXSignature(xSignature);
  if (!ts || !v1) return false;

  const manifest = `id:${dataId};request-id:${xRequestId};ts:${ts};`;

  const hmac = crypto
    .createHmac('sha256', secret)
    .update(manifest)
    .digest('hex');

  return hmac === v1;
}

module.exports = {
  createCheckoutPreference,
  getPaymentById,
  validateMercadoPagoWebhookSignature,
};