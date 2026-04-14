import { env } from "../config/env.js";
import {
  getMelhorEnvioAccessToken,
  buildMelhorEnvioHeaders,
  getMelhorEnvioConfig
} from "./melhorEnvio.service.js";

function onlyDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function getApiBaseUrl() {
  const configured = String(
    process.env.API_BASE_URL || env.apiBaseUrl || ""
  ).trim();

  if (configured) {
    return configured.replace(/\/+$/, "");
  }

  return "http://localhost:5000";
}

function buildFallbackLabelUrl() {
  return `${getApiBaseUrl()}/labels/label-test.pdf`;
}

function buildFallbackResult(order, error = "") {
  const fallbackUrl = buildFallbackLabelUrl();

  return {
    success: true,
    mode: "fallback",
    labelStatus: "fallback",
    labelUrl: fallbackUrl,
    labelPdfUrl: fallbackUrl,
    trackingCode: "",
    carrier: "LOCAL",
    shipmentId: "",
    error: String(error || "").trim(),
    raw: {
      fallback: true,
      orderId: order?.id || null,
      reason: String(error || "Melhor Envio indisponível").trim(),
      generatedAt: new Date().toISOString()
    }
  };
}

function getStoreOriginZipCode() {
  return onlyDigits(
    process.env.STORE_ORIGIN_ZIP_CODE ||
      process.env.FRENET_ORIGIN_ZIP_CODE ||
      env.frenetOriginZipCode ||
      ""
  );
}

function buildMelhorEnvioProducts(items = []) {
  return items.map((item, index) => {
    const quantity = Math.max(1, toNumber(item?.quantity, 1) || 1);

    const width = Math.max(
      1,
      toNumber(item?.width || item?.width_cm || item?.product?.widthCm, 1)
    );

    const height = Math.max(
      1,
      toNumber(item?.height || item?.height_cm || item?.product?.heightCm, 1)
    );

    const length = Math.max(
      1,
      toNumber(item?.length || item?.length_cm || item?.product?.lengthCm, 1)
    );

    const weight = Math.max(
      0.001,
      toNumber(item?.weight || item?.weight_kg || item?.product?.weightKg, 0.3)
    );

    const insuranceValue = Math.max(
      0,
      toNumber(item?.unit_price || item?.price || item?.product?.price, 0)
    );

    return {
      id: String(item?.product_id || item?.sku || item?.id || `item-${index + 1}`),
      width,
      height,
      length,
      weight,
      insurance_value: insuranceValue,
      quantity
    };
  });
}

function normalizeAddressForMelhorEnvio(order) {
  const postalCode = onlyDigits(order?.shipping_cep);
  const street = String(order?.shipping_address || "").trim();
  const number = String(order?.shipping_number || "").trim();
  const complement = String(order?.shipping_complement || "").trim();
  const district = String(order?.shipping_neighborhood || "").trim();
  const city = String(order?.shipping_city || "").trim();
  const stateAbbr = String(order?.shipping_state || "").trim().toUpperCase();

  return {
    postal_code: postalCode,
    address: street,
    number,
    complement,
    district,
    city,
    state_abbr: stateAbbr
  };
}

function buildCartPayload(order, items = []) {
  const originZipCode = getStoreOriginZipCode();

  if (!originZipCode || originZipCode.length < 8) {
    throw new Error("CEP de origem da loja não configurado");
  }

  const destination = normalizeAddressForMelhorEnvio(order);

  if (
    !destination.postal_code ||
    !destination.address ||
    !destination.number ||
    !destination.city ||
    !destination.state_abbr
  ) {
    throw new Error("Endereço do pedido incompleto para gerar etiqueta");
  }

  const products = buildMelhorEnvioProducts(items);

  if (!products.length) {
    throw new Error("Pedido sem itens para gerar etiqueta");
  }

  return {
    service: String(order?.shipping_service_code || "").trim() || undefined,
    from: {
      name: "OZONTECK",
      phone: String(order?.store_phone || "").trim() || undefined,
      email: String(order?.store_email || "").trim() || undefined,
      document: String(order?.store_document || "").trim() || undefined,
      company_document: String(order?.store_company_document || "").trim() || undefined,
      state_register: String(order?.store_state_register || "").trim() || undefined,
      address: process.env.STORE_ORIGIN_ADDRESS || undefined,
      complement: process.env.STORE_ORIGIN_COMPLEMENT || undefined,
      number: process.env.STORE_ORIGIN_NUMBER || undefined,
      district: process.env.STORE_ORIGIN_DISTRICT || undefined,
      city: process.env.STORE_ORIGIN_CITY || undefined,
      country_id: "BR",
      postal_code: originZipCode,
      note: "Remetente OZONTECK"
    },
    to: {
      name: String(order?.customer_name || "").trim(),
      phone: String(order?.customer_phone || "").trim(),
      email: String(order?.customer_email || "").trim(),
      document: String(order?.customer_cpf || "").trim() || undefined,
      company_document: undefined,
      state_register: undefined,
      address: destination.address,
      complement: destination.complement || undefined,
      number: destination.number,
      district: destination.district || undefined,
      city: destination.city,
      country_id: "BR",
      postal_code: destination.postal_code,
      state_abbr: destination.state_abbr,
      note: `Pedido ${String(order?.order_number || order?.id || "").trim()}`
    },
    products,
    options: {
      receipt: false,
      own_hand: false,
      collect: false,
      reverse: false,
      non_commercial: true
    }
  };
}

async function createMelhorEnvioCart(order, items = []) {
  const accessToken = await getMelhorEnvioAccessToken();
  const { baseUrl } = getMelhorEnvioConfig();

  const payload = buildCartPayload(order, items);

  const response = await fetch(`${baseUrl}/me/cart`, {
    method: "POST",
    headers: buildMelhorEnvioHeaders(accessToken),
    body: JSON.stringify(payload)
  });

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(
      data?.message ||
        data?.error ||
        data?.details ||
        "Erro ao inserir frete no carrinho do Melhor Envio"
    );
  }

  return {
    payload,
    data
  };
}

function extractCartIds(cartResponse) {
  const list = Array.isArray(cartResponse)
    ? cartResponse
    : Array.isArray(cartResponse?.data)
      ? cartResponse.data
      : cartResponse?.id
        ? [cartResponse]
        : [];

  const ids = list
    .map((item) => Number(item?.id || 0))
    .filter((id) => Number.isFinite(id) && id > 0);

  return ids;
}

async function checkoutMelhorEnvioCart(cartIds = []) {
  if (!cartIds.length) {
    throw new Error("Nenhum item válido no carrinho do Melhor Envio");
  }

  const accessToken = await getMelhorEnvioAccessToken();
  const { baseUrl } = getMelhorEnvioConfig();

  const response = await fetch(`${baseUrl}/me/shipment/checkout`, {
    method: "POST",
    headers: buildMelhorEnvioHeaders(accessToken),
    body: JSON.stringify({
      orders: cartIds
    })
  });

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(
      data?.message ||
        data?.error ||
        data?.details ||
        "Erro ao comprar etiqueta no Melhor Envio"
    );
  }

  return data;
}

async function getMelhorEnvioShipmentLabel(cartId) {
  const accessToken = await getMelhorEnvioAccessToken();
  const { baseUrl } = getMelhorEnvioConfig();

  const response = await fetch(`${baseUrl}/me/shipment/print`, {
    method: "POST",
    headers: buildMelhorEnvioHeaders(accessToken),
    body: JSON.stringify({
      mode: "private",
      orders: [cartId]
    })
  });

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(
      data?.message ||
        data?.error ||
        "Erro ao gerar PDF da etiqueta no Melhor Envio"
    );
  }

  return data;
}

function normalizeMelhorEnvioLabelResult({
  order,
  cartData,
  checkoutData,
  printData
}) {
  const cartList = Array.isArray(cartData)
    ? cartData
    : Array.isArray(cartData?.data)
      ? cartData.data
      : cartData?.id
        ? [cartData]
        : [];

  const firstCart = cartList[0] || {};

  const trackingCode = String(
    firstCart?.tracking ||
      firstCart?.tracking_code ||
      checkoutData?.tracking ||
      checkoutData?.tracking_code ||
      ""
  ).trim();

  const carrier = String(
    firstCart?.company?.name ||
      firstCart?.company_name ||
      firstCart?.agency ||
      "Melhor Envio"
  ).trim();

  const shipmentId = String(
    firstCart?.id ||
      checkoutData?.id ||
      order?.shipping_shipment_id ||
      ""
  ).trim();

  const labelUrl = String(
    printData?.url ||
      printData?.link ||
      printData?.path ||
      ""
  ).trim();

  if (!labelUrl) {
    throw new Error("Melhor Envio não retornou URL do PDF");
  }

  return {
    success: true,
    mode: "melhor_envio",
    labelStatus: "generated",
    labelUrl,
    labelPdfUrl: labelUrl,
    trackingCode,
    carrier,
    shipmentId,
    error: "",
    raw: {
      cartData,
      checkoutData,
      printData
    }
  };
}

export async function generateAutomaticShippingLabel(order, items = []) {
  try {
    if (!order?.id) {
      return buildFallbackResult(order, "Pedido inválido para gerar etiqueta");
    }

    if (!items?.length) {
      return buildFallbackResult(order, "Pedido sem itens para gerar etiqueta");
    }

    if (!order.shipping_cep || !order.shipping_address || !order.shipping_number) {
      return buildFallbackResult(order, "Endereço incompleto para gerar etiqueta");
    }

    if (!String(order?.shipping_service_code || "").trim()) {
      return buildFallbackResult(order, "Pedido sem serviço de frete selecionado");
    }

    const cartResult = await createMelhorEnvioCart(order, items);
    const cartIds = extractCartIds(cartResult.data);
    const checkoutData = await checkoutMelhorEnvioCart(cartIds);
    const printData = await getMelhorEnvioShipmentLabel(cartIds[0]);

    return normalizeMelhorEnvioLabelResult({
      order,
      cartData: cartResult.data,
      checkoutData,
      printData
    });
  } catch (error) {
    console.error("ERRO MELHOR ENVIO LABEL:", {
  message: error.message,
  orderId: order?.id,
  orderNumber: order?.order_number,
  shippingServiceCode: order?.shipping_service_code,
  shippingCarrier: order?.shipping_carrier,
  shippingCity: order?.shipping_city,
  shippingState: order?.shipping_state,
  shippingCep: order?.shipping_cep
});

    return buildFallbackResult(
      order,
      error.message || "Erro ao gerar etiqueta automática"
    );
  }
}