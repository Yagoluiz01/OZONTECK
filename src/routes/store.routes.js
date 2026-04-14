import express from "express";
import crypto from "crypto";
import { env } from "../config/env.js";
import { calculateShippingWithMelhorEnvio } from "../services/melhorEnvio.service.js";

const router = express.Router();

function slugify(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function onlyDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

function normalizeProduct(product) {
  const id = String(product?.id || "").trim();
  const name = String(product?.name || "").trim();
  const sku = String(product?.sku || "").trim();
  const slug = String(product?.slug || sku || slugify(name || id)).trim();

  return {
    id,
    sku,
    slug,
    name,
    category: String(product?.category || "").trim(),
    shortDescription: String(
      product?.short_description ||
        product?.shortDescription ||
        product?.description ||
        ""
    ).trim(),
    description: String(
      product?.description || product?.short_description || ""
    ).trim(),
    imageUrl: String(product?.image_url || product?.image || "").trim(),
    imageUrl2: String(
      product?.image_url_2 ||
        product?.image2 ||
        product?.image_url ||
        product?.image ||
        ""
    ).trim(),
    price: toNumber(product?.price, 0),
    stockQuantity: toNumber(product?.stock_quantity, 0),
    status: String(product?.status || "").trim().toLowerCase(),
    weightKg: toNumber(product?.weight_kg, 0),
    heightCm: toNumber(product?.height_cm, 0),
    widthCm: toNumber(product?.width_cm, 0),
    lengthCm: toNumber(product?.length_cm, 0)
  };
}

function getMercadoPagoAccessToken() {
  return (
    env.mercadoPagoAccessToken ||
    process.env.MERCADO_PAGO_ACCESS_TOKEN ||
    ""
  ).trim();
}

function getMercadoPagoWebhookSecret() {
  return (
    env.mercadoPagoWebhookSecret ||
    process.env.MERCADO_PAGO_WEBHOOK_SECRET ||
    ""
  ).trim();
}

function getApiBaseUrl(req) {
  const configured = env.apiBaseUrl || process.env.API_BASE_URL || "";

  if (String(configured).trim()) {
    return String(configured).trim().replace(/\/+$/, "");
  }

  const protocol = req.headers["x-forwarded-proto"] || req.protocol || "http";
  const host = req.get("host");

  return `${protocol}://${host}`;
}

function getStoreBackUrls() {
  return {
    success:
      env.storeSuccessUrl ||
      process.env.STORE_SUCCESS_URL ||
      "http://127.0.0.1:5500/frontend/pages-html/pagamento-sucesso.html",
    pending:
      env.storePendingUrl ||
      process.env.STORE_PENDING_URL ||
      "http://127.0.0.1:5500/frontend/pages-html/pagamento-pendente.html",
    failure:
      env.storeFailureUrl ||
      process.env.STORE_FAILURE_URL ||
      "http://127.0.0.1:5500/frontend/pages-html/pagamento-falha.html"
  };
}

function isPaymentSimulationEnabled() {
  const value =
    env.enablePaymentSimulation ||
    process.env.ENABLE_PAYMENT_SIMULATION ||
    "";

  return ["1", "true", "yes", "on"].includes(
    String(value).trim().toLowerCase()
  );
}

function getFrenetConfig() {
  return {
    token: String(env.frenetToken || process.env.FRENET_TOKEN || "").trim(),
    originZipCode: onlyDigits(
      env.frenetOriginZipCode || process.env.FRENET_ORIGIN_ZIP_CODE || ""
    ),
    quoteUrl: String(
      env.frenetQuoteUrl ||
        process.env.FRENET_QUOTE_URL ||
        "https://api.frenet.com.br/shipping/quote"
    ).trim()
  };
}

function buildShippingPackage(items = []) {
  const totalWeight = items.reduce(
    (acc, item) =>
      acc + Number(item.product.weightKg || 0) * Number(item.quantity || 0),
    0
  );

  const maxHeight = items.reduce(
    (acc, item) => Math.max(acc, Number(item.product.heightCm || 0)),
    0
  );

  const maxWidth = items.reduce(
    (acc, item) => Math.max(acc, Number(item.product.widthCm || 0)),
    0
  );

  const totalLength = items.reduce(
    (acc, item) =>
      acc + Number(item.product.lengthCm || 0) * Number(item.quantity || 0),
    0
  );

  return {
    weightKg: totalWeight > 0 ? Number(totalWeight.toFixed(3)) : 0.3,
    heightCm: maxHeight > 0 ? Number(maxHeight.toFixed(2)) : 16,
    widthCm: maxWidth > 0 ? Number(maxWidth.toFixed(2)) : 8,
    lengthCm: totalLength > 0 ? Number(totalLength.toFixed(2)) : 8
  };
}

function mapFrenetQuotes(raw) {
  const possibleLists = [
    raw?.ShippingSevicesArray,
    raw?.ShippingServicesArray,
    raw?.ShippingServices,
    raw?.shippingServices,
    raw?.services,
    raw?.data,
    raw
  ];

  const list = possibleLists.find((item) => Array.isArray(item)) || [];

  return list
    .map((service) => {
      const price =
        Number(
          service?.ShippingPrice ??
            service?.price ??
            service?.Price ??
            service?.OriginalShippingPrice ??
            service?.ServicePrice ??
            0
        ) || 0;

      const deliveryTime =
        Number(
          service?.DeliveryTime ??
            service?.deliveryTime ??
            service?.DeliveryDays ??
            service?.ShippingDeadline ??
            0
        ) || 0;

      const serviceCode = String(
        service?.ServiceCode ??
          service?.serviceCode ??
          service?.Code ??
          service?.Id ??
          ""
      ).trim();

      const serviceName = String(
        service?.ServiceDescription ??
          service?.ServiceName ??
          service?.serviceName ??
          service?.Description ??
          service?.Name ??
          ""
      ).trim();

      const carrier = String(
        service?.Carrier ??
          service?.CarrierName ??
          service?.carrier ??
          service?.Company ??
          service?.Vendor ??
          "Transportadora"
      ).trim();

      return {
        carrier,
        serviceCode,
        serviceName: serviceName || "Serviço",
        price,
        deliveryTime,
        raw: service
      };
    })
    .filter((item) => item.price > 0);
}

async function quoteShippingWithFrenet({ zipCode, items, subtotal }) {
  const config = getFrenetConfig();

  if (!config.token) {
    throw new Error("FRENET_TOKEN não configurado");
  }

  if (!config.originZipCode) {
    throw new Error("FRENET_ORIGIN_ZIP_CODE não configurado");
  }

  const destinationZipCode = onlyDigits(zipCode);

  if (!destinationZipCode || destinationZipCode.length < 8) {
    throw new Error("CEP de destino inválido");
  }

  const pkg = buildShippingPackage(items);

  const payload = {
    SellerCEP: config.originZipCode,
    RecipientCEP: destinationZipCode,
    ShipmentInvoiceValue: Number(subtotal || 0),
    ShippingItemArray: [
      {
        Height: pkg.heightCm,
        Length: pkg.lengthCm,
        Width: pkg.widthCm,
        Weight: pkg.weightKg,
        Quantity: 1
      }
    ]
  };

  const response = await fetch(config.quoteUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      token: config.token
    },
    body: JSON.stringify(payload)
  });

  const text = await response.text();
  let data = null;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    throw new Error(
      data?.message || data?.error || "Erro ao consultar frete na Frenet"
    );
  }

  const quotes = mapFrenetQuotes(data);

  return {
    quotes,
    raw: data,
    package: pkg
  };
}

async function fetchProductsTable() {
  const url = `${env.supabaseUrl}/rest/v1/products?select=*`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      apikey: env.supabaseServiceRoleKey,
      Authorization: `Bearer ${env.supabaseServiceRoleKey}`,
      "Content-Type": "application/json",
      Accept: "application/json"
    }
  });

  const text = await response.text();
  let data = [];

  try {
    data = text ? JSON.parse(text) : [];
  } catch {
    data = [];
  }

  return {
    ok: response.ok,
    status: response.status,
    data: Array.isArray(data) ? data : [],
    raw: data
  };
}

function buildProductSearchMap(products) {
  const map = new Map();

  products.forEach((product) => {
    const id = String(product.id || "").trim();
    const sku = String(product.sku || "").trim();
    const slug = String(product.slug || "").trim();
    const name = String(product.name || "").trim();
    const slugifiedName = slugify(name);

    if (id) {
      map.set(id, product);
      map.set(slugify(id), product);
    }

    if (sku) {
      map.set(sku, product);
      map.set(slugify(sku), product);
    }

    if (slug) {
      map.set(slug, product);
      map.set(slugify(slug), product);
    }

    if (name) {
      map.set(name, product);
      map.set(slugifiedName, product);
    }
  });

  return map;
}

async function fetchProductsMap() {
  const response = await fetchProductsTable();

  if (!response.ok) {
    throw new Error("Erro ao carregar produtos para validação do pedido");
  }

  const products = response.data
    .map(normalizeProduct)
    .filter((product) => product.id && product.name);

  return buildProductSearchMap(products);
}

function generateOrderNumber() {
  const now = new Date();
  const year = now.getFullYear();
  const stamp = Date.now().toString().slice(-6);
  return `OZT-${year}-${stamp}`;
}

async function findOrCreateCustomer(customer) {
  const email = String(customer.email || "").trim().toLowerCase();

  if (!email) {
    throw new Error("E-mail do cliente é obrigatório");
  }

  const searchUrl = new URL(`${env.supabaseUrl}/rest/v1/customers`);
  searchUrl.searchParams.set("select", "id,email");
  searchUrl.searchParams.set("email", `eq.${email}`);
  searchUrl.searchParams.set("limit", "1");

  const searchResponse = await fetch(searchUrl.toString(), {
    method: "GET",
    headers: {
      apikey: env.supabaseServiceRoleKey,
      Authorization: `Bearer ${env.supabaseServiceRoleKey}`,
      "Content-Type": "application/json",
      Accept: "application/json"
    }
  });

  const searchData = await searchResponse.json().catch(() => []);

  if (searchResponse.ok && Array.isArray(searchData) && searchData[0]?.id) {
    return searchData[0].id;
  }

  const createPayload = {
    full_name: String(customer.nome || "").trim(),
    email,
    phone: String(customer.telefone || "").trim(),
    city: String(customer.cidade || "").trim(),
    state: String(customer.estado || "").trim(),
    origin: "Site",
    status: "lead",
    notes: ""
  };

  const createResponse = await fetch(`${env.supabaseUrl}/rest/v1/customers`, {
    method: "POST",
    headers: {
      apikey: env.supabaseServiceRoleKey,
      Authorization: `Bearer ${env.supabaseServiceRoleKey}`,
      "Content-Type": "application/json",
      Prefer: "return=representation"
    },
    body: JSON.stringify(createPayload)
  });

  const createData = await createResponse.json().catch(() => []);

  if (
    !createResponse.ok ||
    !Array.isArray(createData) ||
    !createData[0]?.id
  ) {
    throw new Error("Erro ao criar cliente");
  }

  return createData[0].id;
}

function parseMercadoPagoSignature(signatureHeader = "") {
  const parts = String(signatureHeader)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

  const values = {};

  for (const part of parts) {
    const [key, value] = part.split("=");
    if (key && value) {
      values[key.trim()] = value.trim();
    }
  }

  return {
    ts: values.ts || "",
    v1: values.v1 || ""
  };
}

function validateMercadoPagoWebhookSignature({
  xSignature,
  xRequestId,
  dataId,
  secret
}) {
  if (!xSignature || !xRequestId || !dataId || !secret) {
    return false;
  }

  const { ts, v1 } = parseMercadoPagoSignature(xSignature);

  if (!ts || !v1) {
    return false;
  }

  const manifest = `id:${dataId};request-id:${xRequestId};ts:${ts};`;

  const generated = crypto
    .createHmac("sha256", secret)
    .update(manifest)
    .digest("hex");

  return generated === v1;
}

async function createMercadoPagoPreference({ req, order, items, customer }) {
  const accessToken = getMercadoPagoAccessToken();

  if (!accessToken) {
    throw new Error("MERCADO_PAGO_ACCESS_TOKEN não configurado");
  }

  const apiBaseUrl = getApiBaseUrl(req);
  const backUrls = getStoreBackUrls();

  const body = {
    items: items.map((item) => ({
      id: String(item.product.id || ""),
      title: String(item.product.name || "Produto OZONTECK"),
      quantity: Number(item.quantity || 1),
      unit_price: Number(item.unitPrice || 0),
      currency_id: "BRL"
    })),
    external_reference: String(order.order_number || ""),
    notification_url: `${apiBaseUrl}/api/store/payments/mercado-pago/webhook`,
    back_urls: {
      success: backUrls.success,
      pending: backUrls.pending,
      failure: backUrls.failure
    },
    auto_return: "approved",
    payer: {
      name: String(customer.nome || "").trim() || undefined,
      email: String(customer.email || "").trim().toLowerCase() || undefined,
      phone: String(customer.telefone || "").trim()
        ? {
            number: String(customer.telefone || "").replace(/\D/g, "")
          }
        : undefined
    },
    metadata: {
      order_number: String(order.order_number || ""),
      order_id: String(order.id || "")
    }
  };

  const response = await fetch(
    "https://api.mercadopago.com/checkout/preferences",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    }
  );

  const data = await response.json().catch(() => ({}));

  if (!response.ok || !data?.id) {
    throw new Error(
      data?.message ||
        data?.error ||
        "Erro ao criar preferência de pagamento no Mercado Pago"
    );
  }

  return data;
}

async function getMercadoPagoPayment(paymentId) {
  const accessToken = getMercadoPagoAccessToken();

  if (!accessToken) {
    throw new Error("MERCADO_PAGO_ACCESS_TOKEN não configurado");
  }

  const response = await fetch(
    `https://api.mercadopago.com/v1/payments/${paymentId}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      }
    }
  );

  const data = await response.json().catch(() => ({}));

  if (!response.ok || !data?.id) {
    throw new Error(
      data?.message ||
        data?.error ||
        "Erro ao consultar pagamento no Mercado Pago"
    );
  }

  return data;
}

async function updateOrderById(orderId, payload) {
  const url = new URL(`${env.supabaseUrl}/rest/v1/orders`);
  url.searchParams.set("id", `eq.${orderId}`);

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

  const data = await response.json().catch(() => []);

  return {
    ok: response.ok,
    status: response.status,
    data,
    raw: data
  };
}

async function updateOrderByExternalReference(externalReference, payload) {
  const url = new URL(`${env.supabaseUrl}/rest/v1/orders`);
  url.searchParams.set("payment_external_reference", `eq.${externalReference}`);
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

  const data = await response.json().catch(() => []);

  return {
    ok: response.ok,
    status: response.status,
    data,
    raw: data
  };
}

async function findOrderByExternalReference(externalReference) {
  const url = new URL(`${env.supabaseUrl}/rest/v1/orders`);
  url.searchParams.set("payment_external_reference", `eq.${externalReference}`);
  url.searchParams.set("select", "*");
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

  if (!response.ok || !Array.isArray(data) || !data[0]) {
    throw new Error("Pedido não encontrado pelo external_reference");
  }

  return data[0];
}

async function findOrderItems(orderId) {
  const url = new URL(`${env.supabaseUrl}/rest/v1/order_items`);
  url.searchParams.set("order_id", `eq.${orderId}`);
  url.searchParams.set("select", "*");

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
    throw new Error("Erro ao buscar itens do pedido");
  }

  return Array.isArray(data) ? data : [];
}

function getShippingProvider() {
  return String(process.env.SHIPPING_PROVIDER || "").trim().toLowerCase();
}

function getStoreOriginZipCode() {
  return onlyDigits(
    process.env.STORE_ORIGIN_ZIP_CODE ||
      env.frenetOriginZipCode ||
      process.env.FRENET_ORIGIN_ZIP_CODE ||
      ""
  );
}

function normalizeMelhorEnvioProducts(items = []) {
  return items.map((item, index) => {
    const product = item.product || {};
    const quantity = Number(item.quantity || 1) || 1;

    const width = Math.max(1, Number(product.widthCm || 0) || 1);
    const height = Math.max(1, Number(product.heightCm || 0) || 1);
    const length = Math.max(1, Number(product.lengthCm || 0) || 1);
    const weight = Math.max(0.001, Number(product.weightKg || 0) || 0.3);
    const insuranceValue = Math.max(
      0,
      Number(product.price || item.unitPrice || 0) || 0
    );

    return {
      id: String(product.id || product.sku || `item-${index + 1}`),
      width,
      height,
      length,
      weight,
      insurance_value: insuranceValue,
      quantity
    };
  });
}

function mapMelhorEnvioQuotes(services = []) {
  return services
    .filter((service) => !service?.error)
    .map((service) => {
      const companyName = String(
        service?.company?.name ||
          service?.company?.company_name ||
          "Transportadora"
      ).trim();

      const serviceName = String(service?.name || "Serviço").trim();
      const serviceCode = String(service?.id || "").trim();
      const price = Number(service?.price || 0) || 0;

      const deliveryTime =
        Number(
          service?.delivery_time ||
            service?.custom_delivery_time ||
            service?.packages?.[0]?.delivery_time ||
            0
        ) || 0;

      return {
        carrier: companyName,
        serviceCode,
        serviceName,
        price,
        deliveryTime,
        raw: service
      };
    })
    .filter((item) => item.price > 0);
}

async function quoteShippingWithMelhorEnvio({ zipCode, items }) {
  const originZipCode = getStoreOriginZipCode();
  const destinationZipCode = onlyDigits(zipCode);

  if (!originZipCode || originZipCode.length < 8) {
    throw new Error("CEP de origem da loja não configurado");
  }

  if (!destinationZipCode || destinationZipCode.length < 8) {
    throw new Error("CEP de destino inválido");
  }

  const products = normalizeMelhorEnvioProducts(items);

  const payload = {
    from: {
      postal_code: originZipCode
    },
    to: {
      postal_code: destinationZipCode
    },
    products,
    options: {
      receipt: false,
      own_hand: false,
      collect: false
    }
  };

  const rawServices = await calculateShippingWithMelhorEnvio(payload);
  const quotes = mapMelhorEnvioQuotes(rawServices);

  return {
    quotes,
    raw: rawServices,
    payload
  };
}

async function generateAutomaticShippingLabel(order, items) {
  if (!order?.id) {
    throw new Error("Pedido inválido para gerar etiqueta");
  }

  if (!items?.length) {
    throw new Error("Pedido sem itens para gerar etiqueta");
  }

  if (!order.shipping_cep || !order.shipping_address || !order.shipping_number) {
    throw new Error("Endereço incompleto para gerar etiqueta");
  }

  const trackingCode = `OZT${Date.now()}`;
  const shipmentId = `SHIP-${order.order_number || order.id}`;
  const publicBaseUrl = String(env.apiBaseUrl || "http://localhost:5000").replace(/\/+$/, "");
  const labelUrl = `${publicBaseUrl}/labels/label-test.pdf`;
  const labelPdfUrl = `${publicBaseUrl}/labels/label-test.pdf`;

  return {
    success: true,
    shipmentId,
    trackingCode,
    labelUrl,
    labelPdfUrl,
    raw: {
      mode: "fake_label_local_pdf",
      orderNumber: order.order_number,
      orderId: order.id,
      itemCount: items.length,
      generatedAt: new Date().toISOString()
    }
  };
}

async function saveGeneratedLabel(orderId, labelData) {
  return updateOrderById(orderId, {
    shipping_label_status: "generated",
    shipping_label_url: String(labelData.labelUrl || ""),
    shipping_label_pdf_url: String(labelData.labelPdfUrl || ""),
    shipping_tracking_code: String(labelData.trackingCode || ""),
    shipping_shipment_id: String(labelData.shipmentId || ""),
    shipping_label_generated_at: new Date().toISOString(),
    shipping_label_error: "",
    shipping_label_raw: labelData.raw || null,
    tracking_code: String(labelData.trackingCode || "")
  });
}

async function saveLabelError(orderId, errorMessage) {
  return updateOrderById(orderId, {
    shipping_label_status: "error",
    shipping_label_error: String(errorMessage || "Erro ao gerar etiqueta"),
    shipping_label_generated_at: null
  });
}

router.get("/products", async (req, res) => {
  try {
    const response = await fetchProductsTable();

    if (!response.ok) {
      return res.status(500).json({
        success: false,
        message: "Erro ao buscar produtos da loja",
        details: response.raw
      });
    }

    const products = response.data
      .map(normalizeProduct)
      .filter((product) => product.id && product.name);

    return res.status(200).json({
      success: true,
      products
    });
  } catch (error) {
    console.error("ERRO AO LISTAR PRODUTOS DA LOJA:", error);

    return res.status(500).json({
      success: false,
      message: "Erro interno ao listar produtos da loja",
      details: String(error?.message || error)
    });
  }
});

router.get("/products/:ref", async (req, res) => {
  try {
    const rawRef = String(req.params.ref || "").trim();

    const response = await fetchProductsTable();

    if (!response.ok) {
      return res.status(500).json({
        success: false,
        message: "Erro ao buscar produto da loja",
        details: response.raw
      });
    }

    const products = response.data
      .map(normalizeProduct)
      .filter((product) => product.id && product.name);

    const map = buildProductSearchMap(products);
    const product = map.get(rawRef) || map.get(slugify(rawRef)) || null;

    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Produto não encontrado"
      });
    }

    return res.status(200).json({
      success: true,
      product
    });
  } catch (error) {
    console.error("ERRO AO BUSCAR PRODUTO DA LOJA:", error);

    return res.status(500).json({
      success: false,
      message: "Erro interno ao buscar produto da loja",
      details: String(error?.message || error)
    });
  }
});

router.post("/shipping/quote", async (req, res) => {
  try {
    const body = req.body || {};
    const zipCode = String(body.zipCode || body.cep || "").trim();
    const items = Array.isArray(body.items) ? body.items : [];

    if (!zipCode) {
      return res.status(400).json({
        success: false,
        message: "CEP é obrigatório"
      });
    }

    if (!items.length) {
      return res.status(400).json({
        success: false,
        message: "Itens do carrinho são obrigatórios"
      });
    }

    const productsMap = await fetchProductsMap();

    const normalizedItems = items.map((item) => {
      const ref = String(
        item.id || item.slug || item.sku || item.nome || ""
      ).trim();

      const normalizedRef = slugify(ref);
      const quantity = Math.max(
        1,
        Number(item.quantity || item.quantidade || 1) || 1
      );

      const product = productsMap.get(ref) || productsMap.get(normalizedRef);

      if (!product) {
        throw new Error(
          `Produto inválido no pedido: ${ref || "sem referência"}`
        );
      }

      return {
        product,
        quantity,
        unitPrice: Number(product.price || 0),
        totalPrice: Number(product.price || 0) * quantity
      };
    });

    const subtotal = normalizedItems.reduce(
      (acc, item) => acc + item.totalPrice,
      0
    );

    const provider = getShippingProvider();

    if (provider === "melhor_envio") {
      const result = await quoteShippingWithMelhorEnvio({
        zipCode,
        items: normalizedItems
      });

      return res.status(200).json({
        success: true,
        provider: "melhor_envio",
        quotes: result.quotes,
        raw: result.raw
      });
    }

    const result = await quoteShippingWithFrenet({
      zipCode,
      items: normalizedItems,
      subtotal
    });

    return res.status(200).json({
      success: true,
      provider: "frenet",
      quotes: result.quotes,
      raw: result.raw
    });
  } catch (error) {
    console.error("ERRO AO COTAR FRETE:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Erro interno ao cotar frete"
    });
  }
});

router.post("/orders", async (req, res) => {
  try {
    const body = req.body || {};
    const customer = body.customer || {};
    const items = Array.isArray(body.items) ? body.items : [];
    const notes = String(body.notes || "").trim();

    if (!customer.nome || !customer.email || !customer.telefone) {
      return res.status(400).json({
        success: false,
        message: "Nome, e-mail e telefone são obrigatórios"
      });
    }

    if (!items.length) {
      return res.status(400).json({
        success: false,
        message: "O pedido precisa ter pelo menos 1 item"
      });
    }

    const productsMap = await fetchProductsMap();

    const normalizedItems = items.map((item) => {
      const ref = String(
        item.id || item.slug || item.sku || item.nome || ""
      ).trim();
      const normalizedRef = slugify(ref);
      const quantity = Math.max(
        1,
        Number(item.quantity || item.quantidade || 1) || 1
      );
      const product = productsMap.get(ref) || productsMap.get(normalizedRef);

      if (!product) {
        throw new Error(
          `Produto inválido no pedido: ${ref || "sem referência"}`
        );
      }

      return {
        product,
        quantity,
        unitPrice: Number(product.price || 0),
        totalPrice: Number(product.price || 0) * quantity
      };
    });

    const subtotal = normalizedItems.reduce(
      (acc, item) => acc + item.totalPrice,
      0
    );
    const selectedShipping = body.shipping || {};
    const shippingAmount = Number(
      body.shippingAmount ?? selectedShipping.price ?? 0
    );
    const discountAmount = Number(body.discountAmount || 0);
    const totalAmount = subtotal + shippingAmount - discountAmount;

    await findOrCreateCustomer(customer);
    const orderNumber = generateOrderNumber();

    const orderPayload = {
      order_number: orderNumber,
      customer_name: String(customer.nome || "").trim(),
      customer_email: String(customer.email || "").trim().toLowerCase(),
      customer_phone: String(customer.telefone || "").trim(),
      customer_cpf: String(customer.cpf || "").trim(),
      shipping_cep: String(customer.cep || "").trim(),
      shipping_address: String(customer.endereco || "").trim(),
      shipping_number: String(customer.numero || "").trim(),
      shipping_complement: String(customer.complemento || "").trim(),
      shipping_neighborhood: String(customer.bairro || "").trim(),
      shipping_city: String(customer.cidade || "").trim(),
      shipping_state: String(customer.estado || "").trim(),
      shipping_carrier: String(selectedShipping.carrier || "").trim(),
      shipping_service_code: String(selectedShipping.serviceCode || "").trim(),
      shipping_service_name: String(selectedShipping.serviceName || "").trim(),
      shipping_delivery_time: Number(selectedShipping.deliveryTime || 0) || null,
      shipping_quote_raw: selectedShipping.raw || null,
      shipping_label_status: "pending",
      subtotal: subtotal,
      shipping_amount: shippingAmount,
      discount_amount: discountAmount,
      total_amount: totalAmount,
      payment_status: "pending",
      order_status: "pending",
      tracking_code: "",
      notes
    };

    const orderResponse = await fetch(`${env.supabaseUrl}/rest/v1/orders`, {
      method: "POST",
      headers: {
        apikey: env.supabaseServiceRoleKey,
        Authorization: `Bearer ${env.supabaseServiceRoleKey}`,
        "Content-Type": "application/json",
        Prefer: "return=representation"
      },
      body: JSON.stringify(orderPayload)
    });

    const orderData = await orderResponse.json().catch(() => []);

    if (!orderResponse.ok || !Array.isArray(orderData) || !orderData[0]?.id) {
      return res.status(500).json({
        success: false,
        message: "Erro ao criar pedido",
        details: orderData
      });
    }

    const createdOrder = orderData[0];

    const orderItemsPayload = normalizedItems.map((item) => ({
      order_id: createdOrder.id,
      product_id: item.product.id,
      product_name: item.product.name,
      sku: item.product.sku || "",
      quantity: item.quantity,
      unit_price: item.unitPrice,
      total_price: item.totalPrice
    }));

    const itemsResponse = await fetch(`${env.supabaseUrl}/rest/v1/order_items`, {
      method: "POST",
      headers: {
        apikey: env.supabaseServiceRoleKey,
        Authorization: `Bearer ${env.supabaseServiceRoleKey}`,
        "Content-Type": "application/json",
        Prefer: "return=representation"
      },
      body: JSON.stringify(orderItemsPayload)
    });

    const itemsData = await itemsResponse.json().catch(() => []);

    if (!itemsResponse.ok) {
      return res.status(500).json({
        success: false,
        message: "Pedido criado, mas houve erro ao salvar os itens",
        details: itemsData
      });
    }

    const accessToken = getMercadoPagoAccessToken();

    if (!accessToken) {
      return res.status(201).json({
        success: true,
        message: "Pedido criado com sucesso",
        order: {
          id: createdOrder.id,
          number: createdOrder.order_number,
          total: totalAmount,
          status: createdOrder.order_status,
          paymentStatus: createdOrder.payment_status
        },
        payment: {
          gateway: "simulation_pending",
          preferenceId: "",
          paymentUrl: "",
          sandboxPaymentUrl: "",
          externalReference: createdOrder.order_number
        }
      });
    }

    const preference = await createMercadoPagoPreference({
      req,
      order: createdOrder,
      items: normalizedItems,
      customer
    });

    const paymentUpdate = await updateOrderById(createdOrder.id, {
      payment_gateway: "mercado_pago",
      payment_reference: String(preference.id || ""),
      payment_external_reference: String(createdOrder.order_number || ""),
      payment_raw_status: "preference_created"
    });

    if (!paymentUpdate.ok) {
      return res.status(500).json({
        success: false,
        message:
          "Pedido criado, mas houve erro ao salvar a referência de pagamento",
        details: paymentUpdate.raw
      });
    }

    return res.status(201).json({
      success: true,
      message: "Pedido criado com sucesso",
      order: {
        id: createdOrder.id,
        number: createdOrder.order_number,
        total: totalAmount,
        status: createdOrder.order_status,
        paymentStatus: createdOrder.payment_status
      },
      payment: {
        gateway: "mercado_pago",
        preferenceId: preference.id,
        paymentUrl: preference.init_point || "",
        sandboxPaymentUrl: preference.sandbox_init_point || "",
        externalReference: createdOrder.order_number
      }
    });
  } catch (error) {
    console.error("ERRO AO CRIAR PEDIDO DA LOJA:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Erro interno ao criar pedido"
    });
  }
});

router.post("/payments/mercado-pago/webhook", async (req, res) => {
  try {
    const topic = String(
      req.body?.type ||
        req.query?.type ||
        req.body?.topic ||
        req.query?.topic ||
        ""
    ).trim();

    const dataId = String(
      req.body?.data?.id || req.query?.["data.id"] || ""
    ).trim();

    if (!dataId) {
      return res.status(200).json({
        success: true,
        received: true,
        ignored: true,
        reason: "missing_data_id"
      });
    }

    const secret = getMercadoPagoWebhookSecret();
    const xSignature = String(req.headers["x-signature"] || "").trim();
    const xRequestId = String(req.headers["x-request-id"] || "").trim();

    if (secret) {
      const isValid = validateMercadoPagoWebhookSignature({
        xSignature,
        xRequestId,
        dataId,
        secret
      });

      if (!isValid) {
        return res.status(401).json({
          success: false,
          message: "Assinatura inválida do webhook"
        });
      }
    }

    if (topic !== "payment") {
      return res.status(200).json({
        success: true,
        received: true,
        ignored: true,
        topic
      });
    }

    const payment = await getMercadoPagoPayment(dataId);
    const externalReference = String(payment?.external_reference || "").trim();
    const paymentStatus = String(payment?.status || "").trim().toLowerCase();

    if (!externalReference) {
      return res.status(200).json({
        success: true,
        received: true,
        ignored: true,
        reason: "missing_external_reference"
      });
    }

    const updatePayload = {
      payment_reference: String(payment.id || ""),
      payment_raw_status: paymentStatus,
      webhook_last_event: topic
    };

    if (paymentStatus === "approved") {
      updatePayload.payment_status = "paid";
      updatePayload.paid_at = new Date().toISOString();
      updatePayload.order_status = "paid";
    } else if (
      paymentStatus === "pending" ||
      paymentStatus === "in_process"
    ) {
      updatePayload.payment_status = "pending";
    } else if (
      paymentStatus === "rejected" ||
      paymentStatus === "cancelled" ||
      paymentStatus === "refunded" ||
      paymentStatus === "charged_back"
    ) {
      updatePayload.payment_status = "failed";
      updatePayload.shipping_label_status = "pending";
    }

    const updateResponse = await updateOrderByExternalReference(
      externalReference,
      updatePayload
    );

    if (!updateResponse.ok) {
      return res.status(500).json({
        success: false,
        message: "Erro ao atualizar pedido pelo webhook",
        details: updateResponse.raw
      });
    }

    let labelResult = null;

    if (paymentStatus === "approved") {
      try {
        const updatedOrder =
          Array.isArray(updateResponse.data) && updateResponse.data[0]
            ? updateResponse.data[0]
            : await findOrderByExternalReference(externalReference);

        if (updatedOrder?.shipping_label_status !== "generated") {
          const orderItems = await findOrderItems(updatedOrder.id);
          const generatedLabel = await generateAutomaticShippingLabel(
            updatedOrder,
            orderItems
          );

          const savedLabel = await saveGeneratedLabel(
            updatedOrder.id,
            generatedLabel
          );

          if (!savedLabel.ok) {
            throw new Error("Erro ao salvar dados da etiqueta no pedido");
          }

          labelResult = {
            generated: true,
            trackingCode: generatedLabel.trackingCode,
            shipmentId: generatedLabel.shipmentId
          };
        } else {
          labelResult = {
            generated: false,
            reason: "label_already_exists"
          };
        }
      } catch (labelError) {
        console.error("ERRO AO GERAR ETIQUETA AUTOMÁTICA:", labelError);

        const refreshedOrder =
          Array.isArray(updateResponse.data) && updateResponse.data[0]
            ? updateResponse.data[0]
            : null;

        if (refreshedOrder?.id) {
          await saveLabelError(
            refreshedOrder.id,
            labelError.message || "Erro ao gerar etiqueta"
          );
        }

        labelResult = {
          generated: false,
          error: labelError.message || "Erro ao gerar etiqueta"
        };
      }
    }

    return res.status(200).json({
      success: true,
      received: true,
      externalReference,
      paymentStatus,
      label: labelResult
    });
  } catch (error) {
    console.error("ERRO NO WEBHOOK DO MERCADO PAGO:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Erro interno no webhook"
    });
  }
});

router.post("/payments/simulate/:orderNumber", async (req, res) => {
  try {
    if (!isPaymentSimulationEnabled()) {
      return res.status(403).json({
        success: false,
        message: "Simulação de pagamento desativada"
      });
    }

    const orderNumber = String(req.params.orderNumber || "").trim();
    const status = String(req.body?.status || "approved")
      .trim()
      .toLowerCase();

    if (!orderNumber) {
      return res.status(400).json({
        success: false,
        message: "Número do pedido é obrigatório"
      });
    }

    const updatePayload = {
      payment_gateway: "simulation",
      payment_external_reference: orderNumber,
      webhook_last_event: "simulation"
    };

    if (status === "approved" || status === "paid") {
      updatePayload.payment_status = "paid";
      updatePayload.payment_raw_status = "approved";
      updatePayload.paid_at = new Date().toISOString();
      updatePayload.order_status = "paid";
    } else if (status === "pending") {
      updatePayload.payment_status = "pending";
      updatePayload.payment_raw_status = "pending";
    } else if (status === "failed" || status === "rejected") {
      updatePayload.payment_status = "failed";
      updatePayload.payment_raw_status = "rejected";
    } else {
      return res.status(400).json({
        success: false,
        message: "Status inválido para simulação"
      });
    }

    const directOrderUpdate = await updateOrderByExternalReference(
      orderNumber,
      updatePayload
    );

    if (
      directOrderUpdate.ok &&
      Array.isArray(directOrderUpdate.data) &&
      directOrderUpdate.data.length
    ) {
      const updatedOrder = directOrderUpdate.data[0];

      if ((status === "approved" || status === "paid") && updatedOrder?.id) {
        try {
          if (updatedOrder.shipping_label_status !== "generated") {
            const orderItems = await findOrderItems(updatedOrder.id);
            const generatedLabel = await generateAutomaticShippingLabel(
              updatedOrder,
              orderItems
            );
            await saveGeneratedLabel(updatedOrder.id, generatedLabel);
          }
        } catch (labelError) {
          console.error("ERRO AO GERAR ETIQUETA NA SIMULAÇÃO:", labelError);
          await saveLabelError(
            updatedOrder.id,
            labelError.message || "Erro ao gerar etiqueta na simulação"
          );
        }
      }

      return res.status(200).json({
        success: true,
        message: "Pagamento simulado com sucesso",
        order: updatedOrder
      });
    }

    const findUrl = new URL(`${env.supabaseUrl}/rest/v1/orders`);
    findUrl.searchParams.set("order_number", `eq.${orderNumber}`);
    findUrl.searchParams.set("select", "id,order_number,shipping_label_status");
    findUrl.searchParams.set("limit", "1");

    const findResponse = await fetch(findUrl.toString(), {
      method: "GET",
      headers: {
        apikey: env.supabaseServiceRoleKey,
        Authorization: `Bearer ${env.supabaseServiceRoleKey}`,
        "Content-Type": "application/json",
        Accept: "application/json"
      }
    });

    const findData = await findResponse.json().catch(() => []);

    if (!findResponse.ok || !Array.isArray(findData) || !findData[0]?.id) {
      return res.status(404).json({
        success: false,
        message: "Pedido não encontrado para simulação",
        details: findData
      });
    }

    const fallbackUpdate = await updateOrderById(findData[0].id, updatePayload);

    if (
      !fallbackUpdate.ok ||
      !Array.isArray(fallbackUpdate.data) ||
      !fallbackUpdate.data.length
    ) {
      return res.status(500).json({
        success: false,
        message: "Erro ao atualizar pedido na simulação",
        details: fallbackUpdate.raw
      });
    }

    const updatedOrder = fallbackUpdate.data[0];

    if ((status === "approved" || status === "paid") && updatedOrder?.id) {
      try {
        if (updatedOrder.shipping_label_status !== "generated") {
          const orderItems = await findOrderItems(updatedOrder.id);
          const generatedLabel = await generateAutomaticShippingLabel(
            updatedOrder,
            orderItems
          );
          await saveGeneratedLabel(updatedOrder.id, generatedLabel);
        }
      } catch (labelError) {
        console.error(
          "ERRO AO GERAR ETIQUETA NO FALLBACK DA SIMULAÇÃO:",
          labelError
        );
        await saveLabelError(
          updatedOrder.id,
          labelError.message || "Erro ao gerar etiqueta na simulação"
        );
      }
    }

    return res.status(200).json({
      success: true,
      message: "Pagamento simulado com sucesso",
      order: updatedOrder
    });
  } catch (error) {
    console.error("ERRO AO SIMULAR PAGAMENTO:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Erro interno ao simular pagamento"
    });
  }
});

router.get("/orders/:orderNumber/status", async (req, res) => {
  try {
    const orderNumber = String(req.params.orderNumber || "").trim();

    if (!orderNumber) {
      return res.status(400).json({
        success: false,
        message: "Número do pedido é obrigatório"
      });
    }

    const url = new URL(`${env.supabaseUrl}/rest/v1/orders`);
    url.searchParams.set("order_number", `eq.${orderNumber}`);
    url.searchParams.set(
      "select",
      "id,order_number,payment_status,payment_raw_status,order_status,tracking_code,paid_at,payment_gateway,payment_external_reference,shipping_label_status,shipping_label_url,shipping_label_pdf_url,shipping_tracking_code,shipping_shipment_id,shipping_label_generated_at,shipping_label_error"
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
      return res.status(500).json({
        success: false,
        message: "Erro ao consultar status do pedido",
        details: data
      });
    }

    if (!Array.isArray(data) || !data[0]) {
      return res.status(404).json({
        success: false,
        message: "Pedido não encontrado"
      });
    }

    return res.status(200).json({
      success: true,
      order: data[0]
    });
  } catch (error) {
    console.error("ERRO AO CONSULTAR STATUS DO PEDIDO:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Erro interno ao consultar status do pedido"
    });
  }
});

router.get("/health", async (req, res) => {
  return res.status(200).json({
    success: true,
    message: "Camada pública da loja ativa"
  });
});

export default router;