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

function getApiBaseUrl() {
  const configured = String(
    process.env.API_BASE_URL || env.apiBaseUrl || ""
  ).trim();

  if (configured) {
    return configured.replace(/\/+$/, "");
  }

  return "http://localhost:5000";
}

function isNonCommercialShipment(order) {
  const explicit =
    process.env.MELHOR_ENVIO_NON_COMMERCIAL ??
    order?.shipping_non_commercial ??
    order?.non_commercial;

  if (explicit === undefined || explicit === null || explicit === "") {
    return false;
  }

  const normalized = String(explicit).trim().toLowerCase();
  return ["1", "true", "yes", "on", "sim"].includes(normalized);
}

function buildFailureResult(order, error = "", extra = {}) {
  const message = String(error || "Erro ao gerar etiqueta automática").trim();

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

function buildMelhorEnvioProducts(items = []) {
  return items.map((item, index) => {
    const quantity = getItemQuantity(item);

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

    const insuranceValue = getItemUnitDeclaredValue(item);

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

function buildMelhorEnvioVolumes(order, items = []) {
  const raw = order?.shipping_quote_raw || {};
  const packages = Array.isArray(raw?.packages) ? raw.packages : [];
  const totalDeclaredValue = getOrderDeclaredValue(items);

  if (packages.length) {
    return packages.map((pkg, index) => ({
      id: String(pkg?.id || `volume-${index + 1}`),
      format: String(pkg?.format || "box"),
      width: Math.max(1, toNumber(pkg?.width || pkg?.dimensions?.width, 1)),
      height: Math.max(1, toNumber(pkg?.height || pkg?.dimensions?.height, 1)),
      length: Math.max(1, toNumber(pkg?.length || pkg?.dimensions?.length, 1)),
      weight: Math.max(0.001, toNumber(pkg?.weight, 0.3)),
      insurance_value: Math.max(
        0,
        roundMoney(
          pkg?.insurance_value !== undefined
            ? pkg.insurance_value
            : totalDeclaredValue
        )
      ),
      products:
        Array.isArray(pkg?.products) && pkg.products.length
          ? pkg.products.map((p) => ({
              id: String(p?.id || p?.product_id || p?.sku || "produto"),
              quantity: Math.max(1, toNumber(p?.quantity, 1))
            }))
          : items.map((item, itemIndex) => ({
              id: String(item?.product_id || item?.sku || item?.id || `item-${itemIndex + 1}`),
              quantity: getItemQuantity(item)
            }))
    }));
  }

  return [
    {
      id: "volume-1",
      format: "box",
      width: Math.max(
        1,
        items.reduce(
          (max, item) =>
            Math.max(max, toNumber(item?.width || item?.width_cm || item?.product?.widthCm, 1)),
          1
        )
      ),
      height: Math.max(
        1,
        items.reduce(
          (sum, item) =>
            sum + Math.max(1, toNumber(item?.height || item?.height_cm || item?.product?.heightCm, 1)),
          0
        )
      ),
      length: Math.max(
        1,
        items.reduce(
          (max, item) =>
            Math.max(max, toNumber(item?.length || item?.length_cm || item?.product?.lengthCm, 1)),
          1
        )
      ),
      weight: Math.max(
        0.001,
        items.reduce(
          (sum, item) =>
            sum + Math.max(0.001, toNumber(item?.weight || item?.weight_kg || item?.product?.weightKg, 0.3)),
          0
        )
      ),
      insurance_value: totalDeclaredValue,
      products: items.map((item, index) => ({
        id: String(item?.product_id || item?.sku || item?.id || `item-${index + 1}`),
        quantity: getItemQuantity(item)
      }))
    }
  ];
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
  const volumes = buildMelhorEnvioVolumes(order, items);

  if (!products.length) {
    throw new Error("Pedido sem itens para gerar etiqueta");
  }

  if (!volumes.length) {
    throw new Error("Pedido sem volumes para gerar etiqueta");
  }

  const declaredValue = getOrderDeclaredValue(items);

  if (declaredValue <= 0) {
    throw new Error("Valor declarado do pedido inválido para gerar etiqueta");
  }

  return {
    service: Number(order?.shipping_service_code),
    from: {
      name: String(process.env.STORE_ORIGIN_NAME || "OZONTECK").trim(),
      phone: String(process.env.STORE_ORIGIN_PHONE || order?.store_phone || "").trim() || undefined,
      email: String(process.env.STORE_ORIGIN_EMAIL || order?.store_email || "").trim() || undefined,
      document: String(process.env.STORE_ORIGIN_DOCUMENT || order?.store_document || "").trim() || undefined,
      company_document: String(
        process.env.STORE_ORIGIN_COMPANY_DOCUMENT || order?.store_company_document || ""
      ).trim() || undefined,
      state_register: String(
        process.env.STORE_ORIGIN_STATE_REGISTER || order?.store_state_register || ""
      ).trim() || undefined,
      address: String(process.env.STORE_ORIGIN_ADDRESS || "").trim() || undefined,
      complement: String(process.env.STORE_ORIGIN_COMPLEMENT || "").trim() || undefined,
      number: String(process.env.STORE_ORIGIN_NUMBER || "").trim() || undefined,
      district: String(process.env.STORE_ORIGIN_DISTRICT || "").trim() || undefined,
      city: String(process.env.STORE_ORIGIN_CITY || "").trim() || undefined,
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
    volumes,
    options: {
      receipt: false,
      own_hand: false,
      collect: false,
      reverse: false,
      non_commercial: isNonCommercialShipment(order)
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
    console.error(
      "MELHOR ENVIO CHECKOUT ERROR: " +
        JSON.stringify({
          status: response.status,
          data,
          cartIds
        })
    );

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
    console.error(
      "MELHOR ENVIO PRINT ERROR: " +
        JSON.stringify({
          status: response.status,
          data,
          cartId
        })
    );

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
      return buildFailureResult(order, "Pedido inválido para gerar etiqueta", {
        labelStatus: "invalid_order"
      });
    }

    if (!items?.length) {
      return buildFailureResult(order, "Pedido sem itens para gerar etiqueta", {
        labelStatus: "invalid_items"
      });
    }

    if (!order.shipping_cep || !order.shipping_address || !order.shipping_number) {
      return buildFailureResult(order, "Endereço incompleto para gerar etiqueta", {
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

    const cartIds = extractCartIds(cartResult.data);
    console.log("MELHOR ENVIO STEP: cart ids " + JSON.stringify(cartIds));

    console.log("MELHOR ENVIO STEP: checkout");
    const checkoutData = await checkoutMelhorEnvioCart(cartIds);

    console.log("MELHOR ENVIO STEP: print");
    const printData = await getMelhorEnvioShipmentLabel(cartIds[0]);

    return normalizeMelhorEnvioLabelResult({
      order,
      cartData: cartResult.data,
      checkoutData,
      printData
    });
  } catch (error) {
    console.error(
      "ERRO MELHOR ENVIO LABEL: " +
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
      error.message || "Erro ao gerar etiqueta automática",
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