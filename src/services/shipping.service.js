import { sendCustomerOrderPushForTracking } from "./customerOrderPush.service.js";
import { env } from "../config/env.js";
import {
  getMelhorEnvioAccessToken,
  buildMelhorEnvioHeaders,
  getMelhorEnvioConfig
} from "./melhorEnvio.service.js";
import { syncAffiliateCommissionLifecycleForOrder } from "./affiliateCommissionLifecycle.service.js";

function onlyDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

function normalizeStateAbbr(value) {
  const normalized = String(value || "").trim().toUpperCase();
  return /^[A-Z]{2}$/.test(normalized) ? normalized : "";
}

function normalizeComparableAddress(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
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
    process.env.MELHOR_ENVIO_ORIGIN_ZIP_CODE ||
      process.env.MELHOR_ENVIO_FROM_POSTAL_CODE ||
      process.env.MELHOR_ENVIO_POSTAL_CODE ||
      process.env.STORE_ORIGIN_ZIP_CODE ||
      process.env.FRENET_ORIGIN_ZIP_CODE ||
      env.frenetOriginZipCode ||
      process.env.ORIGIN_ZIP_CODE ||
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
    address: String(
      process.env.STORE_ORIGIN_ADDRESS ||
        process.env.MELHOR_ENVIO_ORIGIN_ADDRESS ||
        process.env.MELHOR_ENVIO_FROM_ADDRESS ||
        ""
    ).trim(),
    complement: String(
      process.env.STORE_ORIGIN_COMPLEMENT ||
        process.env.MELHOR_ENVIO_ORIGIN_COMPLEMENT ||
        process.env.MELHOR_ENVIO_FROM_COMPLEMENT ||
        ""
    ).trim(),
    number: String(
      process.env.STORE_ORIGIN_NUMBER ||
        process.env.MELHOR_ENVIO_ORIGIN_NUMBER ||
        process.env.MELHOR_ENVIO_FROM_NUMBER ||
        ""
    ).trim(),
    district: String(
      process.env.STORE_ORIGIN_DISTRICT ||
        process.env.MELHOR_ENVIO_ORIGIN_DISTRICT ||
        process.env.MELHOR_ENVIO_FROM_DISTRICT ||
        ""
    ).trim(),
    city: String(
      process.env.STORE_ORIGIN_CITY ||
        process.env.MELHOR_ENVIO_ORIGIN_CITY ||
        process.env.MELHOR_ENVIO_FROM_CITY ||
        ""
    ).trim(),
    state_abbr: normalizeStateAbbr(
      process.env.STORE_ORIGIN_STATE ||
        process.env.MELHOR_ENVIO_ORIGIN_STATE ||
        process.env.MELHOR_ENVIO_FROM_STATE ||
        process.env.ORIGIN_STATE ||
        ""
    )
  };
}

function validateStoreOriginAddress(originAddress, destination) {
  const missing = [];

  if (!originAddress.address) missing.push("STORE_ORIGIN_ADDRESS");
  if (!originAddress.number) missing.push("STORE_ORIGIN_NUMBER");
  if (!originAddress.district) missing.push("STORE_ORIGIN_DISTRICT");
  if (!originAddress.city) missing.push("STORE_ORIGIN_CITY");
  if (!originAddress.state_abbr) missing.push("STORE_ORIGIN_STATE");

  if (missing.length) {
    throw new Error(
      `Endereço de origem da loja incompleto para Melhor Envio: ${missing.join(", ")}`
    );
  }

  const sameAsDestination =
    normalizeComparableAddress(originAddress.address) === normalizeComparableAddress(destination.address) &&
    normalizeComparableAddress(originAddress.number) === normalizeComparableAddress(destination.number) &&
    normalizeComparableAddress(originAddress.city) === normalizeComparableAddress(destination.city) &&
    normalizeComparableAddress(originAddress.state_abbr) === normalizeComparableAddress(destination.state_abbr) &&
    onlyDigits(getStoreOriginZipCode()) === onlyDigits(destination.postal_code);

  if (sameAsDestination) {
    throw new Error(
      "Endereço de origem da loja igual ao endereço do cliente. Confira as variáveis STORE_ORIGIN_* no Render."
    );
  }
}

function getMelhorEnvioAgencyId() {
  const agencyId = onlyDigits(
    process.env.MELHOR_ENVIO_AGENCY_ID ||
      process.env.MELHOR_ENVIO_JADLOG_AGENCY_ID ||
      process.env.JADLOG_AGENCY_ID ||
      ""
  );

  return agencyId ? Number(agencyId) : null;
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

  validateStoreOriginAddress(originAddress, destination);

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
    state_abbr: originAddress.state_abbr || undefined,
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

  const agencyId = getMelhorEnvioAgencyId();

  console.log("SERVIÇO DE TRANSPORTE NOVO ATIVO V2");
  console.log(
    "MELHOR ENVIO ORIGIN CHECK: " +
      JSON.stringify({
        orderId: order?.id || null,
        orderNumber: order?.order_number || null,
        fromPostalCode: from.postal_code,
        fromCity: from.city,
        fromState: from.state_abbr,
        fromAddress: from.address,
        toPostalCode: to.postal_code,
        toCity: to.city,
        toState: to.state_abbr,
        toAddress: to.address,
        agencyId: agencyId || null
      })
  );
  console.log("DEBUG REMETENTE DOCUMENT:", from.document);
  console.log("DEBUG DESTINATARIO DOCUMENT:", to.document);
  console.log("DEPURAR PEDIDO CLIENTE CPF:", order?.customer_cpf);

  const payload = {
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

  if (agencyId) {
    payload.agency = agencyId;
  }

  return payload;
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
    labelStatus: "awaiting_shipping_label",
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

function collectObjects(node, acc = []) {
  if (!node) return acc;

  if (Array.isArray(node)) {
    for (const item of node) {
      collectObjects(item, acc);
    }
    return acc;
  }

  if (typeof node === "object") {
    acc.push(node);
    for (const value of Object.values(node)) {
      collectObjects(value, acc);
    }
  }

  return acc;
}

function pickFirstString(obj, keys = []) {
  for (const key of keys) {
    const value = String(obj?.[key] || "").trim();
    if (value) return value;
  }
  return "";
}

function extractTrackingInfoFromResponse(data, shipmentId) {
  const objects = collectObjects(data, []);
  const normalizedShipmentId = String(shipmentId || "").trim();

  let matched = objects.find((item) => {
    const candidateId = pickFirstString(item, ["id", "order_id", "cart_id"]);
    return candidateId && candidateId === normalizedShipmentId;
  });

  if (!matched) {
    matched = objects.find((item) => {
      return Boolean(
        pickFirstString(item, [
          "tracking",
          "tracking_code",
          "status",
          "situation",
          "state",
          "shipment_status"
        ])
      );
    });
  }

  const trackingCode = pickFirstString(matched || {}, [
  "tracking",
  "tracking_code",
  "melhorenvio_tracking",
  "code"
]);

  const status = pickFirstString(matched || {}, [
    "status",
    "situation",
    "state",
    "shipment_status"
  ]);

  const carrier = pickFirstString(matched || {}, [
    "carrier",
    "company_name",
    "agency"
  ]);

  return {
    trackingCode,
    status,
    carrier,
    raw: matched || null
  };
}

function extractLabelUrlFromResponse(data) {
  const objects = collectObjects(data, []);

  const matched = objects.find((item) => {
    return Boolean(
      pickFirstString(item, ["url", "link", "path", "pdf", "pdf_url"])
    );
  });

  const url = pickFirstString(matched || {}, [
    "url",
    "link",
    "path",
    "pdf",
    "pdf_url"
  ]);

  return {
    url,
    raw: matched || null
  };
}

async function postMelhorEnvioEndpoint(accessToken, baseUrl, endpoint, body) {
  const response = await fetch(`${baseUrl}${endpoint}`, {
    method: "POST",
    headers: buildMelhorEnvioHeaders(accessToken),
    body: JSON.stringify(body)
  });

  const data = await response.json().catch(() => null);

  return {
    ok: response.ok,
    status: response.status,
    data
  };
}

async function fetchPendingCartCreatedOrders(limit = 20) {
  const url = new URL(`${env.supabaseUrl}/rest/v1/orders`);
  url.searchParams.set(
    "select",
    [
      "id",
      "order_number",
      "payment_status",
      "shipping_carrier",
      "shipping_tracking_code",
      "tracking_code",
      "shipping_label_status",
      "shipping_label_url",
      "shipping_label_pdf_url",
      "shipping_shipment_id",
      "shipping_label_error",
      "shipping_label_raw",
      "order_status",
      "shipped_at",
      "delivered_at",
      "paid_at",
      "created_at"
    ].join(",")
  );
  url.searchParams.set("shipping_label_status", "in.(pending,awaiting_shipping_label,generated)");
  url.searchParams.set("shipping_shipment_id", "not.is.null");
  url.searchParams.set("order", "paid_at.asc.nullslast,created_at.asc");
  url.searchParams.set("limit", String(Math.max(1, Number(limit) || 20)));

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      apikey: env.supabaseServiceRoleKey,
      Authorization: `Bearer ${env.supabaseServiceRoleKey}`,
      "Content-Type": "application/json",
      Accept: "application/json"
    }
  });

  const data = await response.json().catch(() => []);

  if (!response.ok) {
    throw new Error("Erro ao buscar pedidos pendentes de sincronização do Melhor Envio");
  }

  return Array.isArray(data) ? data : [];
}

async function updateOrderSyncRecord(orderId, payload) {
  const url = new URL(`${env.supabaseUrl}/rest/v1/orders`);
  url.searchParams.set("id", `eq.${orderId}`);
  url.searchParams.set("select", "*");

  const response = await fetch(url.toString(), {
    method: "PATCH",
    headers: {
      apikey: env.supabaseServiceRoleKey,
      Authorization: `Bearer ${env.supabaseServiceRoleKey}`,
      "Content-Type": "application/json",
      Prefer: "return=representation"
    },
    body: JSON.stringify(payload)
  });

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    console.error(
      "ERRO UPDATE ORDER SYNC RECORD: " +
        JSON.stringify({
          orderId,
          status: response.status,
          payload,
          data
        })
    );

    throw new Error(
      data?.message ||
        data?.error ||
        data?.details ||
        "Erro ao atualizar pedido sincronizado do Melhor Envio"
    );
  }

  return Array.isArray(data) ? data[0] || null : null;
}

  


async function addOrderSyncTimeline(orderId, label, description) {
  const response = await fetch(`${env.supabaseUrl}/rest/v1/rpc/add_order_timeline_event`, {
    method: "POST",
    headers: {
      apikey: env.supabaseServiceRoleKey,
      Authorization: `Bearer ${env.supabaseServiceRoleKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      p_order_id: orderId,
      p_event_label: label,
      p_event_description: description
    })
  });

  if (!response.ok) {
    const data = await response.json().catch(() => null);
    console.error(
      "MELHOR ENVIO SYNC TIMELINE ERROR: " +
        JSON.stringify({
          orderId,
          label,
          description,
          data
        })
    );
  }
}

function mergeShippingLabelRaw(existingRaw, patch) {
  const base =
    existingRaw && typeof existingRaw === "object"
      ? existingRaw
      : {};

  return {
    ...base,
    ...patch
  };
}

async function syncAffiliateCommissionAfterShippingUpdate(order, source) {
  try {
    if (!order?.id) {
      return {
        success: false,
        skipped: true,
        reason: "missing_order_after_shipping_update"
      };
    }

    const result = await syncAffiliateCommissionLifecycleForOrder(order, source);

    console.log(
      "AFFILIATE COMMISSION AFTER MELHOR ENVIO SYNC: " +
        JSON.stringify({
          orderId: order.id,
          orderNumber: order.order_number || null,
          orderStatus: order.order_status || null,
          deliveredAt: order.delivered_at || null,
          source,
          result
        })
    );

    return result;
  } catch (error) {
    console.error(
      "AFFILIATE COMMISSION AFTER MELHOR ENVIO SYNC ERROR: " +
        JSON.stringify({
          orderId: order?.id || null,
          orderNumber: order?.order_number || null,
          source,
          message: error?.message || String(error)
        })
    );

    return {
      success: false,
      skipped: false,
      error: error?.message || "Erro ao sincronizar comissão após Melhor Envio"
    };
  }
}


function normalizeShippingStatus(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function isOrderAlreadyFinalStatus(status) {
  return ["delivered", "cancelled", "failed"].includes(
    String(status || "").trim().toLowerCase()
  );
}

function isMelhorEnvioDeliveredStatus(status) {
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
    "objeto_entregue"
  ].includes(normalizeShippingStatus(status));
}

function isMelhorEnvioActuallyShippedStatus(status) {
  return [
    "posted",
    "postado",
    "shipped",
    "enviado",
    "sent",
    "in_transit",
    "intransit",
    "em_transito",
    "collected",
    "coletado",
    "picked_up",
    "pickup_completed",
    "objeto_postado",
    "objeto_em_transito"
  ].includes(normalizeShippingStatus(status));
}

function getMelhorEnvioShippedAt(trackingRaw, fallback) {
  const explicitTimestamp = pickFirstNonEmptyString(
    trackingRaw?.posted_at,
    trackingRaw?.shipped_at,
    trackingRaw?.collected_at,
    trackingRaw?.picked_up_at,
    trackingRaw?.in_transit_at
  );

  if (explicitTimestamp && !Number.isNaN(Date.parse(explicitTimestamp))) {
    return new Date(explicitTimestamp).toISOString();
  }

  return fallback;
}

function pickFirstNonEmptyString(...values) {
  for (const value of values) {
    const text = String(value || "").trim();

    if (text) {
      return text;
    }
  }

  return "";
}

function hasSavedShippingLabelData(order = {}) {
  return Boolean(
    pickFirstNonEmptyString(
      order.shipping_label_url,
      order.shipping_label_pdf_url,
      order.shipping_tracking_code,
      order.tracking_code
    )
  );
}

function shouldMarkAsGenerated({ labelUrl, trackingCode, trackingStatus }) {
  const normalizedStatus = normalizeShippingStatus(trackingStatus);

  return Boolean(
    String(labelUrl || "").trim() ||
      String(trackingCode || "").trim() ||
      [
        "released",
        "generated",
        "paid",
        "posted",
        "postado",
        "shipped",
        "enviado",
        "in_transit",
        "em_transito",
        "delivered",
        "entregue"
      ].includes(normalizedStatus)
  );
}

async function syncSingleCartCreatedOrder(order, accessToken, baseUrl) {
  const shipmentId = String(order?.shipping_shipment_id || "").trim();

  if (!shipmentId) {
    return {
      orderId: order?.id || null,
      orderNumber: order?.order_number || null,
      status: "skipped_missing_shipment_id"
    };
  }

  const trackingResponse = await postMelhorEnvioEndpoint(
    accessToken,
    baseUrl,
    "/me/shipment/tracking",
    {
      orders: [shipmentId]
    }
  );

   const previewResponse = await postMelhorEnvioEndpoint(
    accessToken,
    baseUrl,
    "/me/shipment/preview",
    {
      orders: [shipmentId]
    }
  );

  console.log("MELHOR ENVIO PREVIEW STATUS:", previewResponse.status);
  console.log("MELHOR ENVIO PREVIEW RAW:", JSON.stringify(previewResponse.data));

  let printResponse = null;

  if (!previewResponse.ok) {
    printResponse = await postMelhorEnvioEndpoint(
      accessToken,
      baseUrl,
      "/me/shipment/print",
      {
        mode: "private",
        orders: [shipmentId]
      }
    );
  }

  console.log("MELHOR ENVIO PRINT STATUS:", printResponse?.status || null);
  console.log("MELHOR ENVIO PRINT RAW:", JSON.stringify(printResponse?.data || null));

  const trackingInfo = extractTrackingInfoFromResponse(
    trackingResponse.data,
    shipmentId
  );

  const previewInfo = extractLabelUrlFromResponse(previewResponse.data);
  const printInfo = extractLabelUrlFromResponse(printResponse?.data);

  const labelUrl = String(previewInfo.url || printInfo.url || "").trim();
  const trackingCode = String(
    trackingInfo.trackingCode ||
      order?.shipping_tracking_code ||
      order?.tracking_code ||
      ""
  ).trim();

  const carrier = String(
    trackingInfo.carrier ||
      order?.shipping_carrier ||
      "Melhor Envio"
  ).trim();

 const shouldGenerate = shouldMarkAsGenerated({
  labelUrl,
  trackingCode,
  trackingStatus: trackingInfo.status
});

  const mergedRaw = mergeShippingLabelRaw(order?.shipping_label_raw, {
    sync_attempted_at: new Date().toISOString(),
    sync_tracking_response: trackingResponse.data,
    sync_preview_response: previewResponse.data,
    sync_print_response: printResponse?.data || null,
    sync_tracking_status: trackingInfo.status || "",
    sync_tracking_code: trackingInfo.trackingCode || "",
    sync_label_url: labelUrl || "",
    sync_label_generated: shouldGenerate
  });

 if (!shouldGenerate) {
  const savedLabelUrl = pickFirstNonEmptyString(order?.shipping_label_url);
  const savedLabelPdfUrl = pickFirstNonEmptyString(
    order?.shipping_label_pdf_url,
    order?.shipping_label_url
  );
  const savedTrackingCode = pickFirstNonEmptyString(
    order?.shipping_tracking_code,
    order?.tracking_code
  );
  const pendingPayload = {
    shipping_label_status: hasSavedShippingLabelData(order)
      ? order?.shipping_label_status || "generated"
      : "pending",
    shipping_label_error: "",
    shipping_label_raw: mergedRaw
  };

  if (savedLabelUrl) {
    pendingPayload.shipping_label_url = savedLabelUrl;
  }

  if (savedLabelPdfUrl) {
    pendingPayload.shipping_label_pdf_url = savedLabelPdfUrl;
  }

  if (savedTrackingCode) {
    pendingPayload.shipping_tracking_code = savedTrackingCode;
    pendingPayload.tracking_code = savedTrackingCode;
  }

  await updateOrderSyncRecord(order.id, pendingPayload);

  return {
    orderId: order?.id || null,
    orderNumber: order?.order_number || null,
    status: "cart_still_pending",
    shipmentId
  };
}

  const now = new Date().toISOString();
  const resolvedLabelUrl = pickFirstNonEmptyString(
    labelUrl,
    order?.shipping_label_url,
    order?.shipping_label_pdf_url
  );
  const resolvedLabelPdfUrl = pickFirstNonEmptyString(
    labelUrl,
    order?.shipping_label_pdf_url,
    order?.shipping_label_url
  );
  const resolvedTrackingCode = pickFirstNonEmptyString(
    trackingCode,
    order?.shipping_tracking_code,
    order?.tracking_code
  );
  const syncUpdatePayload = {
    shipping_label_status: "generated",
    shipping_label_url: resolvedLabelUrl,
    shipping_label_pdf_url: resolvedLabelPdfUrl,
    shipping_tracking_code: resolvedTrackingCode,
    tracking_code: resolvedTrackingCode || order?.tracking_code || "",
    shipping_carrier: carrier || order?.shipping_carrier || "",
    shipping_label_generated_at: order?.shipping_label_generated_at || now,
    shipping_label_error: "",
    shipping_label_raw: mergedRaw
  };

  if (isMelhorEnvioDeliveredStatus(trackingInfo.status)) {
    syncUpdatePayload.order_status = "delivered";
    syncUpdatePayload.delivered_at = order?.delivered_at || now;

    if (!order?.shipped_at) {
      syncUpdatePayload.shipped_at = getMelhorEnvioShippedAt(
        trackingInfo.raw,
        now
      );
    }
  } else if (
    isMelhorEnvioActuallyShippedStatus(trackingInfo.status) &&
    !isOrderAlreadyFinalStatus(order?.order_status)
  ) {
    syncUpdatePayload.order_status = "shipped";

    if (!order?.shipped_at) {
      syncUpdatePayload.shipped_at = getMelhorEnvioShippedAt(
        trackingInfo.raw,
        now
      );
    }
  }

  const updatedOrder = await updateOrderSyncRecord(order.id, syncUpdatePayload);

  await syncAffiliateCommissionAfterShippingUpdate(
    updatedOrder || {
      ...order,
      ...syncUpdatePayload
    },
    "melhor_envio_label_sync"
  );


    const customerTrackingOrder = updatedOrder || {
    ...order,
    ...syncUpdatePayload
  };

  const customerTrackingCode = String(
    customerTrackingOrder?.shipping_tracking_code ||
      customerTrackingOrder?.tracking_code ||
      trackingCode ||
      ""
  ).trim();

  const customerOrderStatus = String(
    customerTrackingOrder?.order_status ||
      syncUpdatePayload?.order_status ||
      ""
  ).toLowerCase();

  if (
    customerTrackingCode &&
    ["shipped", "enviado", "delivered", "entregue"].includes(customerOrderStatus)
  ) {
    try {
      const customerTrackingPushResult =
        await sendCustomerOrderPushForTracking({
          ...customerTrackingOrder,
          shipping_tracking_code: customerTrackingCode,
          tracking_code: customerTrackingCode
        });

      console.log("CUSTOMER TRACKING PUSH AFTER MELHOR ENVIO SYNC:", {
        orderId: customerTrackingOrder?.id || null,
        orderNumber: customerTrackingOrder?.order_number || null,
        trackingCode: customerTrackingCode,
        orderStatus: customerOrderStatus,
        result: customerTrackingPushResult
      });
    } catch (pushError) {
      console.error("ERRO AO ENVIAR PUSH DE RASTREIO PARA CLIENTE:", {
        orderId: customerTrackingOrder?.id || null,
        orderNumber: customerTrackingOrder?.order_number || null,
        trackingCode: customerTrackingCode,
        error: pushError?.message || String(pushError)
      });
    }
  }

  await addOrderSyncTimeline(
    order.id,
    "Etiqueta sincronizada automaticamente",
    [
      "Etiqueta detectada automaticamente após compra manual no Melhor Envio.",
      carrier ? `Transportadora: ${carrier}.` : "",
      trackingCode ? `Código de rastreio: ${trackingCode}.` : "",
      shipmentId ? `ID do envio/carrinho: ${shipmentId}.` : "",
      labelUrl ? `URL da etiqueta: ${labelUrl}.` : ""
    ]
      .filter(Boolean)
      .join(" ")
  );

  return {
    orderId: order?.id || null,
    orderNumber: order?.order_number || null,
    status: "generated",
    orderStatus: updatedOrder?.order_status || syncUpdatePayload.order_status || order?.order_status || null,
    deliveredAt: updatedOrder?.delivered_at || syncUpdatePayload.delivered_at || order?.delivered_at || null,
    shipmentId,
    trackingCode,
    labelUrl
  };
}

export async function syncSpecificMelhorEnvioLabelNow(order) {
  if (!order?.id) {
    throw new Error("Pedido inválido para sincronização imediata");
  }

  if (!String(order?.shipping_shipment_id || "").trim()) {
    throw new Error("Pedido sem ID de envio/carrinho para sincronização");
  }

  const accessToken = await getMelhorEnvioAccessToken();
  const { baseUrl } = getMelhorEnvioConfig();

  return syncSingleCartCreatedOrder(order, accessToken, baseUrl);
}

export async function syncPendingMelhorEnvioLabels({
  limit = 20
} = {}) {
  const pendingOrders = await fetchPendingCartCreatedOrders(limit);

  if (!pendingOrders.length) {
    return {
      success: true,
      checked: 0,
      updated: 0,
      pending: 0,
      results: []
    };
  }

  const accessToken = await getMelhorEnvioAccessToken();
  const { baseUrl } = getMelhorEnvioConfig();

  const results = [];

  for (const order of pendingOrders) {
    try {
      const result = await syncSingleCartCreatedOrder(order, accessToken, baseUrl);
      results.push(result);
    } catch (error) {
      console.error(
        "MELHOR ENVIO AUTO SYNC ERROR: " +
          JSON.stringify({
            orderId: order?.id || null,
            orderNumber: order?.order_number || null,
            shipmentId: order?.shipping_shipment_id || null,
            message: error.message
          })
      );

      results.push({
        orderId: order?.id || null,
        orderNumber: order?.order_number || null,
        status: "error",
        message: error.message
      });
    }
  }

  const updated = results.filter((item) => item.status === "generated").length;
  const pending = results.filter((item) => item.status === "cart_still_pending").length;

  return {
    success: true,
    checked: pendingOrders.length,
    updated,
    pending,
    results
  };
}


function extractSavedShipmentId(order = {}) {
  const directId = String(order?.shipping_shipment_id || "").trim();
  if (directId) return directId;

  const raw = order?.shipping_label_raw || null;
  if (!raw || typeof raw !== "object") return "";

  return String(
    raw.cartId ||
      raw.shipmentId ||
      raw.id ||
      raw.cartData?.id ||
      raw.data?.id ||
      ""
  ).trim();
}

function buildExistingCartResult(order = {}, reason = "existing_cart") {
  const shipmentId = extractSavedShipmentId(order);
  const raw =
    order?.shipping_label_raw && typeof order.shipping_label_raw === "object"
      ? order.shipping_label_raw
      : null;

  return {
    success: true,
    skipped: true,
    mode: "melhor_envio_cart_reused",
    labelStatus: "awaiting_shipping_label",
    labelUrl: String(order?.shipping_label_url || ""),
    labelPdfUrl: String(order?.shipping_label_pdf_url || ""),
    trackingCode: String(order?.shipping_tracking_code || order?.tracking_code || ""),
    carrier: String(order?.shipping_carrier || "Melhor Envio").trim(),
    shipmentId,
    error: "",
    raw: raw || {
      cartId: shipmentId,
      reason,
      reused_at: new Date().toISOString()
    }
  };
}

async function fetchOrderShippingSnapshot(orderId) {
  const id = String(orderId || "").trim();
  if (!id) return null;

  const url = new URL(`${env.supabaseUrl}/rest/v1/orders`);
  url.searchParams.set("id", `eq.${id}`);
  url.searchParams.set(
    "select",
    [
      "id",
      "order_number",
      "shipping_label_status",
      "shipping_label_url",
      "shipping_label_pdf_url",
      "shipping_tracking_code",
      "tracking_code",
      "shipping_shipment_id",
      "shipping_label_error",
      "shipping_label_raw",
      "shipping_carrier"
    ].join(",")
  );
  url.searchParams.set("limit", "1");

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      apikey: env.supabaseServiceRoleKey,
      Authorization: `Bearer ${env.supabaseServiceRoleKey}`,
      "Content-Type": "application/json",
      Accept: "application/json"
    }
  });

  const data = await response.json().catch(() => []);

  if (!response.ok) {
    console.error(
      "ERRO AO CONSULTAR SNAPSHOT DE FRETE DO PEDIDO: " +
        JSON.stringify({ orderId: id, status: response.status, data })
    );
    return null;
  }

  return Array.isArray(data) ? data[0] || null : null;
}

async function claimMelhorEnvioCartCreation(order) {
  const orderId = String(order?.id || "").trim();
  if (!orderId) return null;

  const url = new URL(`${env.supabaseUrl}/rest/v1/orders`);
  url.searchParams.set("id", `eq.${orderId}`);
  url.searchParams.set("shipping_shipment_id", "is.null");
  url.searchParams.set(
    "or",
    "(shipping_label_status.is.null,shipping_label_status.in.(pending,error,blocked_me_cart_403,invalid_order,invalid_items,invalid_address,missing_service))"
  );

  const payload = {
    shipping_label_status: "awaiting_shipping_label",
    shipping_label_error: "",
    processed_at: new Date().toISOString()
  };

  const response = await fetch(url.toString(), {
    method: "PATCH",
    headers: {
      apikey: env.supabaseServiceRoleKey,
      Authorization: `Bearer ${env.supabaseServiceRoleKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      Prefer: "return=representation"
    },
    body: JSON.stringify(payload)
  });

  const data = await response.json().catch(() => []);

  if (!response.ok) {
    console.error(
      "ERRO AO RESERVAR GERAÇÃO DO CARRINHO MELHOR ENVIO: " +
        JSON.stringify({ orderId, status: response.status, data })
    );
    return null;
  }

  const claimed = Array.isArray(data) ? data[0] || null : null;

  if (claimed?.id) {
    console.log(
      "MELHOR ENVIO IDEMPOTENCY LOCK: " +
        JSON.stringify({
          orderId,
          orderNumber: claimed.order_number || order?.order_number || null,
          status: claimed.shipping_label_status || null
        })
    );
  }

  return claimed;
}

function buildShippingAlreadyInProgressResult(order = {}) {
  return {
    success: true,
    skipped: true,
    mode: "melhor_envio_cart_in_progress",
    labelStatus: "awaiting_shipping_label",
    labelUrl: "",
    labelPdfUrl: "",
    trackingCode: "",
    carrier: String(order?.shipping_carrier || "Melhor Envio").trim(),
    shipmentId: "",
    error: "",
    raw: {
      reason: "shipping_cart_creation_already_in_progress",
      orderId: order?.id || null,
      orderNumber: order?.order_number || null,
      checked_at: new Date().toISOString()
    }
  };
}

export async function generateAutomaticShippingLabel(order, items = [], options = {}) {
  try {
    const claimAlreadyAcquired = Boolean(options?.claimAlreadyAcquired);
    if (!order?.id) {
      return buildFailureResult(order, "Pedido inválido para criar carrinho", {
        labelStatus: "invalid_order"
      });
    }

    const existingShipmentId = extractSavedShipmentId(order);
    if (existingShipmentId) {
      console.log(
        "MELHOR ENVIO CART SKIP EXISTING LOCAL: " +
          JSON.stringify({
            orderId: order.id,
            orderNumber: order.order_number || null,
            shipmentId: existingShipmentId
          })
      );
      return buildExistingCartResult(order, "existing_order_payload");
    }

    const latestBeforeClaim = await fetchOrderShippingSnapshot(order.id);
    const latestShipmentId = extractSavedShipmentId(latestBeforeClaim);
    if (latestShipmentId) {
      console.log(
        "MELHOR ENVIO CART SKIP EXISTING DATABASE: " +
          JSON.stringify({
            orderId: order.id,
            orderNumber: order.order_number || latestBeforeClaim?.order_number || null,
            shipmentId: latestShipmentId
          })
      );
      return buildExistingCartResult(
        {
          ...order,
          ...latestBeforeClaim
        },
        "existing_database_record"
      );
    }

    let claimedOrder = order;

    if (!claimAlreadyAcquired) {
      claimedOrder = await claimMelhorEnvioCartCreation(order);

      if (!claimedOrder?.id) {
        const latestAfterClaim = await fetchOrderShippingSnapshot(order.id);
        const shipmentIdAfterClaim = extractSavedShipmentId(latestAfterClaim);

        if (shipmentIdAfterClaim) {
          return buildExistingCartResult(
            {
              ...order,
              ...latestAfterClaim
            },
            "existing_database_record_after_claim"
          );
        }

        console.warn(
          "MELHOR ENVIO CART SKIP IN PROGRESS: " +
            JSON.stringify({
              orderId: order.id,
              orderNumber: order.order_number || null,
              status: latestAfterClaim?.shipping_label_status || null
            })
        );

        return buildShippingAlreadyInProgressResult({
          ...order,
          ...latestAfterClaim
        });
      }
    } else {
      console.log(
        "MELHOR ENVIO IDEMPOTENCY LOCK REUSED: " +
          JSON.stringify({
            orderId: order.id,
            orderNumber: order.order_number || null
          })
      );
    }

    order = {
      ...order,
      ...claimedOrder
    };

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