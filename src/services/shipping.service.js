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

function roundMoney(value) {
  return Math.round((toNumber(value, 0) + Number.EPSILON) * 100) / 100;
}

function buildFailureResult(order, error = "", extra = {}) {
  const message = String(error || "Erro ao criar carrinho automático no Melhor Envio").trim();

  return {
    success: false,
    mode: "melhor_envio_error",
    labelStatus: extra?.labelStatus || "error",
    labelUrl: "",
    labelPdfUrl: "",
    trackingCode: "",
    carrier: String(order?.shipping_carrier || "Melhor Envio").trim(),
    shipmentId: "",
    error: message,
    raw: {
      fallback: false,
      orderId: order?.id || null,
      orderNumber: order?.order_number || null,
      reason: message,
      generatedAt: new Date().toISOString(),
      ...extra
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

function getStoreOriginDocument(order) {
  return onlyDigits(
    process.env.STORE_DOCUMENT ||
      process.env.STORE_COMPANY_DOCUMENT ||
      order?.store_document ||
      ""
  );
}

function getStoreOriginName() {
  return String(process.env.STORE_ORIGIN_NAME || "OZONTECK").trim();
}

function getStorePhone(order) {
  return String(process.env.STORE_PHONE || order?.store_phone || "").trim();
}

function getStoreEmail(order) {
  return String(process.env.STORE_EMAIL || order?.store_email || "").trim();
}

function getStoreOriginAddress() {
  return {
    address: String(process.env.STORE_ORIGIN_ADDRESS || "").trim(),
    complement: String(process.env.STORE_ORIGIN_COMPLEMENT || "").trim(),
    number: String(process.env.STORE_ORIGIN_NUMBER || "").trim(),
    district: String(process.env.STORE_ORIGIN_DISTRICT || "").trim(),
    city: String(process.env.STORE_ORIGIN_CITY || "").trim()
  };
}

function getItemUnitDeclaredValue(item) {
  return roundMoney(
    item?.unit_price ??
      item?.price ??
      item?.product?.price ??
      item?.declared_value ??
      0
  );
}

function getItemQuantity(item) {
  return Math.max(1, toNumber(item?.quantity, 1) || 1);
}

function getOrderDeclaredValue(items = []) {
  return roundMoney(
    items.reduce((sum, item) => {
      return sum + getItemUnitDeclaredValue(item) * getItemQuantity(item);
    }, 0)
  );
}

function getItemName(item, index) {
  return String(
    item?.product_name ||
      item?.name ||
      item?.product?.name ||
      item?.title ||
      `Produto ${index + 1}`
  ).trim();
}

function getItemId(item, index) {
  return String(
    item?.product_id ||
      item?.sku ||
      item?.id ||
      `item-${index + 1}`
  ).trim();
}

function buildMelhorEnvioProducts(items = []) {
  return items.map((item, index) => ({
    id: getItemId(item, index),
    name: getItemName(item, index),
    unitary_value: getItemUnitDeclaredValue(item),
    quantity: getItemQuantity(item)
  }));
}

function buildSingleVolumeFromItems(items = []) {
  const width = Math.max(
    1,
    items.reduce((max, item) => {
      return Math.max(
        max,
        toNumber(item?.width || item?.width_cm || item?.product?.widthCm, 1)
      );
    }, 1)
  );

  const height = Math.max(
    1,
    items.reduce((sum, item) => {
      return sum + Math.max(
        1,
        toNumber(item?.height || item?.height_cm || item?.product?.heightCm, 1)
      );
    }, 0)
  );

  const length = Math.max(
    1,
    items.reduce((max, item) => {
      return Math.max(
        max,
        toNumber(item?.length || item?.length_cm || item?.product?.lengthCm, 1)
      );
    }, 1)
  );

  const weight = Math.max(
    0.001,
    items.reduce((sum, item) => {
      return sum + Math.max(
        0.001,
        toNumber(item?.weight || item?.weight_kg || item?.product?.weightKg, 0.3)
      );
    }, 0)
  );

  return {
    id: "volume-1",
    width,
    height,
    length,
    weight
  };
}

function buildMelhorEnvioVolumes(order, items = []) {
  const raw = order?.shipping_quote_raw || {};
  const packages = Array.isArray(raw?.packages) ? raw.packages : [];

  if (packages.length) {
    return packages.map((pkg, index) => ({
      id: String(pkg?.id || `volume-${index + 1}`),
      width: Math.max(1, toNumber(pkg?.width || pkg?.dimensions?.width, 1)),
      height: Math.max(1, toNumber(pkg?.height || pkg?.dimensions?.height, 1)),
      length: Math.max(1, toNumber(pkg?.length || pkg?.dimensions?.length, 1)),
      weight: Math.max(0.001, toNumber(pkg?.weight, 0.3))
    }));
  }

  return [buildSingleVolumeFromItems(items)];
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

function resolveMelhorEnvioServiceCode(order) {
  const raw = String(order?.shipping_service_code || "").trim();

  console.log("DEBUG SHIPPING SERVICE CODE RAW:", raw);

  const directNumber = Number(raw);
  console.log("DEBUG SHIPPING SERVICE CODE NUMBER:", directNumber);

  if (Number.isFinite(directNumber) && directNumber > 0) {
    return directNumber;
  }

  const rawQuote = order?.shipping_quote_raw || {};

  const candidates = [
    rawQuote?.serviceCode,
    rawQuote?.service_code,
    rawQuote?.ServiceCode,
    rawQuote?.Code,
    rawQuote?.Id,
    rawQuote?.id,
    rawQuote?.raw?.serviceCode,
    rawQuote?.raw?.service_code,
    rawQuote?.raw?.ServiceCode,
    rawQuote?.raw?.Code,
    rawQuote?.raw?.Id,
    rawQuote?.raw?.id
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean);

  console.log("DEBUG SHIPPING SERVICE CODE CANDIDATES:", JSON.stringify(candidates));

  for (const candidate of candidates) {
    const n = Number(candidate);
    if (Number.isFinite(n) && n > 0) {
      console.log("DEBUG SHIPPING SERVICE CODE RESOLVED FROM QUOTE:", n);
      return n;
    }
  }

  return null;
}

function buildCartPayload(order, items = []) {
  const originZipCode = getStoreOriginZipCode();
  const originDocument = getStoreOriginDocument(order);
  const originAddress = getStoreOriginAddress();

  if (!originZipCode || originZipCode.length < 8) {
    throw new Error("CEP de origem da loja não configurado");
  }

  if (!originDocument) {
    throw new Error("Documento do remetente não configurado");
  }

  const destination = normalizeAddressForMelhorEnvio(order);

  if (
    !destination.postal_code ||
    !destination.address ||
    !destination.number ||
    !destination.city ||
    !destination.state_abbr
  ) {
    throw new Error("Endereço do pedido incompleto para criar carrinho");
  }

  const products = buildMelhorEnvioProducts(items);
  const volumes = buildMelhorEnvioVolumes(order, items);

  if (!products.length) {
    throw new Error("Pedido sem itens para criar carrinho");
  }

  if (!volumes.length) {
    throw new Error("Pedido sem volumes para criar carrinho");
  }

  const declaredValue = getOrderDeclaredValue(items);

  if (declaredValue <= 0) {
    throw new Error("Valor declarado do pedido inválido para criar carrinho");
  }

  const serviceCode = resolveMelhorEnvioServiceCode(order);

  if (!serviceCode) {
    throw new Error(
      `Código de serviço do Melhor Envio inválido no pedido: ${String(order?.shipping_service_code || "").trim()}`
    );
  }

  const from = {
    name: getStoreOriginName(),
    phone: getStorePhone(order) || undefined,
    email: getStoreEmail(order) || undefined,
    document: originDocument,
    address: originAddress.address || undefined,
    complement: originAddress.complement || undefined,
    number: originAddress.number || undefined,
    district: originAddress.district || undefined,
    city: originAddress.city || undefined,
    country_id: "BR",
    postal_code: originZipCode
  };

  const to = {
    name: String(order?.customer_name || "").trim(),
    phone: String(order?.customer_phone || "").trim() || undefined,
    email: String(order?.customer_email || "").trim() || undefined,
    document: onlyDigits(order?.customer_cpf) || undefined,
    address: destination.address,
    complement: destination.complement || undefined,
    number: destination.number,
    district: destination.district || undefined,
    city: destination.city,
    country_id: "BR",
    postal_code: destination.postal_code,
    state_abbr: destination.state_abbr,
    note: `Pedido ${String(order?.order_number || order?.id || "").trim()}`
  };

  console.log("SERVIÇO DE TRANSPORTE NOVO ATIVO V2");
  console.log("DEBUG REMETENTE DOCUMENT:", from.document);
  console.log("DEBUG DESTINATARIO DOCUMENT:", to.document);
  console.log("DEPURAR PEDIDO CLIENTE CPF:", order?.customer_cpf);

  return {
    service: serviceCode,
    from,
    to,
    products,
    volumes,
    options: {
      insurance_value: declaredValue,
      receipt: false,
      own_hand: false,
      collect: false,
      reverse: false,
      non_commercial: true
    }
  };
}

function headersToObject(headers) {
  try {
    return Object.fromEntries(headers.entries());
  } catch {
    return {};
  }
}

async function createMelhorEnvioCart(order, items = []) {
  const accessToken = await getMelhorEnvioAccessToken();
  const { baseUrl } = getMelhorEnvioConfig();

  const payload = buildCartPayload(order, items);

  console.log("MELHOR ENVIO CART PAYLOAD: " + JSON.stringify(payload));

  const response = await fetch(`${baseUrl}/me/cart`, {
    method: "POST",
    headers: buildMelhorEnvioHeaders(accessToken),
    body: JSON.stringify(payload)
  });

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    const responseHeaders = headersToObject(response.headers);

    console.error(
      "MELHOR ENVIO CART ERROR: " +
        JSON.stringify({
          status: response.status,
          data,
          payload,
          responseHeaders
        })
    );

    const message =
      data?.message ||
      data?.error ||
      data?.details ||
      "Erro ao inserir frete no carrinho do Melhor Envio";

    const error = new Error(message);
    error.httpStatus = response.status;
    error.responseData = data;
    error.responseHeaders = responseHeaders;
    error.payload = payload;
    throw error;
  }

  console.log(
    "MELHOR ENVIO CART SUCCESS: " +
      JSON.stringify({
        status: response.status,
        data
      })
  );

  return {
    payload,
    data
  };
}

function extractCartInfo(cartResponse) {
  const source =
    cartResponse?.data && !Array.isArray(cartResponse.data)
      ? cartResponse.data
      : Array.isArray(cartResponse)
        ? cartResponse[0] || {}
        : cartResponse?.id
          ? cartResponse
          : {};

  const id = String(
    source?.id || source?.order_id || source?.cart_id || ""
  ).trim();

  const protocol = String(
    source?.protocol || source?.protocolo || ""
  ).trim();

  const status = String(
    source?.status || ""
  ).trim();

  const carrier = String(
    source?.company?.name ||
      source?.agency ||
      ""
  ).trim();

  return {
    id,
    protocol,
    status,
    carrier,
    rawItem: source
  };
}

function normalizeCartCreatedResult({
  order,
  cartData
}) {
  const info = extractCartInfo(cartData);

  if (!info.id) {
    throw new Error(
      "O Melhor Envio respondeu ao criar o carrinho, mas nenhum ID foi identificado."
    );
  }

  const carrier = String(
    info.carrier ||
      order?.shipping_carrier ||
      "Melhor Envio"
  ).trim();

  return {
    success: true,
    mode: "melhor_envio_cart_created",
    labelStatus: "cart_created",
    labelUrl: "",
    labelPdfUrl: "",
    trackingCode: "",
    carrier,
    shipmentId: info.id,
    error: "",
    raw: {
      cartId: info.id,
      cartProtocol: info.protocol,
      cartStatus: info.status,
      cartData
    }
  };
}

export async function generateAutomaticShippingLabel(order, items = []) {
  try {
    if (!order?.id) {
      return buildFailureResult(order, "Pedido inválido para criar carrinho", {
        labelStatus: "invalid_order"
      });
    }

    if (!items?.length) {
      return buildFailureResult(order, "Pedido sem itens para criar carrinho", {
        labelStatus: "invalid_items"
      });
    }

    if (!order.shipping_cep || !order.shipping_address || !order.shipping_number) {
      return buildFailureResult(order, "Endereço incompleto para criar carrinho", {
        labelStatus: "invalid_address"
      });
    }

    if (!String(order?.shipping_service_code || "").trim()) {
      return buildFailureResult(order, "Pedido sem serviço de frete selecionado", {
        labelStatus: "missing_service"
      });
    }

    console.log("MELHOR ENVIO STEP: criar carrinho");
    const cartResult = await createMelhorEnvioCart(order, items);

    const cartInfo = extractCartInfo(cartResult.data);
    console.log(
      "MELHOR ENVIO STEP: cart criado " +
        JSON.stringify({
          id: cartInfo.id,
          protocol: cartInfo.protocol,
          status: cartInfo.status,
          carrier: cartInfo.carrier
        })
    );

    return normalizeCartCreatedResult({
      order,
      cartData: cartResult.data
    });
  } catch (error) {
    console.error(
      "ERRO MELHOR ENVIO CART: " +
        JSON.stringify({
          message: error.message,
          httpStatus: error?.httpStatus || null,
          responseData: error?.responseData || null,
          responseHeaders: error?.responseHeaders || null,
          payload: error?.payload || null,
          orderId: order?.id,
          orderNumber: order?.order_number,
          shippingServiceCode: order?.shipping_service_code,
          shippingCarrier: order?.shipping_carrier,
          shippingCity: order?.shipping_city,
          shippingState: order?.shipping_state,
          shippingCep: order?.shipping_cep
        })
    );

    const blocked403 = Number(error?.httpStatus || 0) === 403;

    return buildFailureResult(
      order,
      error.message || "Erro ao criar carrinho automático",
      {
        labelStatus: blocked403 ? "blocked_me_cart_403" : "error",
        httpStatus: error?.httpStatus || null,
        responseData: error?.responseData || null,
        responseHeaders: error?.responseHeaders || null,
        payload: error?.payload || null
      }
    );
  }
}