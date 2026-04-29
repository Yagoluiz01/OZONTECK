import {
  notifyOrderCreatedPending,
  notifyOrderPaid,
  notifyOrderPaymentPending,
  notifyOrderPaymentFailed
} from "../services/orderNotification.service.js";
import {
  notifyAffiliateCreated,
  notifyAffiliateCommissionCreated
} from "../services/affiliateNotification.service.js";
import express from "express";
import bcrypt from "bcryptjs";
import { requireAdminAuth } from "../middlewares/auth.middleware.js";
import crypto from "crypto";
import { env } from "../config/env.js";
import {
  calculateShippingWithMelhorEnvio,
  buildMelhorEnvioAuthorizeUrl
} from "../services/melhorEnvio.service.js";
import { generateAutomaticShippingLabel } from "../services/shipping.service.js";
import { processPaidOrder } from "../jobs/processPaidOrder.js";
import { createActivationOfferForPaidOrder } from "../services/customerActivation.service.js";

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


function normalizeAffiliateCode(value) {
  return String(value || "")
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, "");
}


function cleanText(value) {
  return String(value || "").trim();
}

function normalizeEmail(value) {
  return cleanText(value).toLowerCase();
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(value));
}

async function findAffiliateApplicationByEmail(email) {
  const cleanEmail = normalizeEmail(email);

  if (!cleanEmail) {
    return null;
  }

  const url = new URL(`${env.supabaseUrl}/rest/v1/affiliate_applications`);
  url.searchParams.set("select", "id,email,status,created_at");
  url.searchParams.set("email", `eq.${cleanEmail}`);
  url.searchParams.set("status", "eq.pending");
  url.searchParams.set("limit", "1");

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      apikey: env.supabaseServiceRoleKey,
      Authorization: `Bearer ${env.supabaseServiceRoleKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
  });

  const data = await response.json().catch(() => []);

  if (!response.ok || !Array.isArray(data) || !data[0]?.id) {
    return null;
  }

  return data[0];
}

function buildAffiliateCodeBase(fullName, email) {
  const fromName = normalizeAffiliateCode(
    String(fullName || "")
      .trim()
      .split(/\s+/)
      .filter(Boolean)[0] || ""
  );

  if (fromName && fromName.length >= 3) {
    return fromName.slice(0, 8);
  }

  const fromEmail = normalizeAffiliateCode(String(email || "").split("@")[0]);

  if (fromEmail && fromEmail.length >= 3) {
    return fromEmail.slice(0, 8);
  }

  return "OZT";
}

async function affiliateCodeExists({ refCode, couponCode }) {
  const cleanRefCode = normalizeAffiliateCode(refCode);
  const cleanCouponCode = normalizeAffiliateCode(couponCode);

  if (!cleanRefCode && !cleanCouponCode) {
    return false;
  }

  const headers = {
    apikey: env.supabaseServiceRoleKey,
    Authorization: `Bearer ${env.supabaseServiceRoleKey}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  if (cleanRefCode) {
    const affiliatesRefUrl = new URL(`${env.supabaseUrl}/rest/v1/affiliates`);
    affiliatesRefUrl.searchParams.set("select", "id");
    affiliatesRefUrl.searchParams.set("ref_code", `eq.${cleanRefCode}`);
    affiliatesRefUrl.searchParams.set("limit", "1");

    const affiliatesRefResponse = await fetch(affiliatesRefUrl.toString(), {
      method: "GET",
      headers,
    });

    const affiliatesRefData = await affiliatesRefResponse.json().catch(() => []);

    if (
      affiliatesRefResponse.ok &&
      Array.isArray(affiliatesRefData) &&
      affiliatesRefData[0]?.id
    ) {
      return true;
    }

    const applicationsRefUrl = new URL(
      `${env.supabaseUrl}/rest/v1/affiliate_applications`
    );
    applicationsRefUrl.searchParams.set("select", "id");
    applicationsRefUrl.searchParams.set("desired_ref_code", `eq.${cleanRefCode}`);
    applicationsRefUrl.searchParams.set("status", "eq.pending");
    applicationsRefUrl.searchParams.set("limit", "1");

    const applicationsRefResponse = await fetch(applicationsRefUrl.toString(), {
      method: "GET",
      headers,
    });

    const applicationsRefData = await applicationsRefResponse
      .json()
      .catch(() => []);

    if (
      applicationsRefResponse.ok &&
      Array.isArray(applicationsRefData) &&
      applicationsRefData[0]?.id
    ) {
      return true;
    }
  }

  if (cleanCouponCode) {
    const affiliatesCouponUrl = new URL(`${env.supabaseUrl}/rest/v1/affiliates`);
    affiliatesCouponUrl.searchParams.set("select", "id");
    affiliatesCouponUrl.searchParams.set("coupon_code", `eq.${cleanCouponCode}`);
    affiliatesCouponUrl.searchParams.set("limit", "1");

    const affiliatesCouponResponse = await fetch(
      affiliatesCouponUrl.toString(),
      {
        method: "GET",
        headers,
      }
    );

    const affiliatesCouponData = await affiliatesCouponResponse
      .json()
      .catch(() => []);

    if (
      affiliatesCouponResponse.ok &&
      Array.isArray(affiliatesCouponData) &&
      affiliatesCouponData[0]?.id
    ) {
      return true;
    }

    const applicationsCouponUrl = new URL(
      `${env.supabaseUrl}/rest/v1/affiliate_applications`
    );
    applicationsCouponUrl.searchParams.set("select", "id");
    applicationsCouponUrl.searchParams.set(
      "desired_coupon_code",
      `eq.${cleanCouponCode}`
    );
    applicationsCouponUrl.searchParams.set("status", "eq.pending");
    applicationsCouponUrl.searchParams.set("limit", "1");

    const applicationsCouponResponse = await fetch(
      applicationsCouponUrl.toString(),
      {
        method: "GET",
        headers,
      }
    );

    const applicationsCouponData = await applicationsCouponResponse
      .json()
      .catch(() => []);

    if (
      applicationsCouponResponse.ok &&
      Array.isArray(applicationsCouponData) &&
      applicationsCouponData[0]?.id
    ) {
      return true;
    }
  }

  return false;
}

async function generateUniqueAffiliateCodes({ fullName, email }) {
  const base = buildAffiliateCodeBase(fullName, email);

  for (let attempt = 0; attempt < 30; attempt += 1) {
    const randomNumber = crypto.randomInt(1000, 9999);
    const refCode = normalizeAffiliateCode(`${base}${randomNumber}`);
    const couponCode = refCode;

    const exists = await affiliateCodeExists({
      refCode,
      couponCode,
    });

    if (!exists) {
      return {
        refCode,
        couponCode,
      };
    }
  }

  const fallback = normalizeAffiliateCode(`OZT${Date.now().toString().slice(-8)}`);

  return {
    refCode: fallback,
    couponCode: fallback,
  };
}

async function createAffiliateApplication(input = {}) {
  const fullName = cleanText(input.full_name || input.fullName || input.name);
  const email = normalizeEmail(input.email);
  const phone = cleanText(input.phone || input.telefone);
  const pixKey = cleanText(input.pix_key || input.pixKey);
  const password = String(input.password || "").trim();
  const passwordConfirm = String(
    input.password_confirm || input.passwordConfirm || ""
  ).trim();

  if (!fullName) {
    throw new Error("Nome completo é obrigatório.");
  }

  if (fullName.length < 3) {
    throw new Error("Informe um nome completo válido.");
  }

  if (!email) {
    throw new Error("E-mail é obrigatório.");
  }

  if (!isValidEmail(email)) {
    throw new Error("Informe um e-mail válido.");
  }

  if (!phone) {
    throw new Error("Telefone é obrigatório.");
  }

  if (!pixKey) {
    throw new Error("Chave Pix é obrigatória.");
  }

  if (!password) {
    throw new Error("Senha é obrigatória.");
  }

  if (password.length < 8) {
    throw new Error("A senha precisa ter pelo menos 8 caracteres.");
  }

  if (!/[A-Z]/.test(password)) {
    throw new Error("A senha precisa ter pelo menos uma letra maiúscula.");
  }

  if (!/[a-z]/.test(password)) {
    throw new Error("A senha precisa ter pelo menos uma letra minúscula.");
  }

  if (!/[0-9]/.test(password)) {
    throw new Error("A senha precisa ter pelo menos um número.");
  }

  if (passwordConfirm && password !== passwordConfirm) {
    throw new Error("As senhas não conferem.");
  }

  const passwordHash = await bcrypt.hash(password, 10);

  const existingPending = await findAffiliateApplicationByEmail(email);

  if (existingPending) {
    return {
      alreadyExists: true,
      application: existingPending,
    };
  }

  const generatedCodes = await generateUniqueAffiliateCodes({
    fullName,
    email,
  });

  const payload = {
    full_name: fullName,
    email,
    phone,
    pix_key: pixKey,
    password_hash: passwordHash,
    instagram: null,
    message: null,
    desired_ref_code: generatedCodes.refCode,
    desired_coupon_code: generatedCodes.couponCode,
    status: "pending",
    admin_notes: null,
  };

  const response = await fetch(
    `${env.supabaseUrl}/rest/v1/affiliate_applications`,
    {
      method: "POST",
      headers: {
        apikey: env.supabaseServiceRoleKey,
        Authorization: `Bearer ${env.supabaseServiceRoleKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify(payload),
    }
  );

  const data = await response.json().catch(() => []);

    if (!response.ok || !Array.isArray(data) || !data[0]?.id) {
    console.error("ERRO SUPABASE AFFILIATE APPLICATION:", data);
    throw new Error("Erro ao salvar solicitação de afiliado.");
  }

  const application = data[0];

  try {
    await notifyAffiliateCreated(application);
  } catch (notificationError) {
    console.error(
      "ERRO AO ENVIAR NOTIFICAÇÃO DE SOLICITAÇÃO DE AFILIADO:",
      notificationError
    );
  }

  return {
    alreadyExists: false,
    application,
  };
}

async function findActiveAffiliateByRef(refCode) {
  const cleanRefCode = normalizeAffiliateCode(refCode);

  if (!cleanRefCode) {
    return null;
  }

  const url = new URL(`${env.supabaseUrl}/rest/v1/affiliates`);
  url.searchParams.set("select", "*");
  url.searchParams.set("ref_code", `eq.${cleanRefCode}`);
  url.searchParams.set("status", "eq.active");
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

  if (!response.ok || !Array.isArray(data) || !data[0]?.id) {
    return null;
  }

  return data[0];
}

async function createActivationOfferSafely(order, source = "unknown") {
  try {
    const result = await createActivationOfferForPaidOrder(order);

    console.log("CUSTOMER ACTIVATION OFFER RESULT:", {
      source,
      orderId: order?.id || null,
      orderNumber: order?.order_number || null,
      created: result?.created || false,
      skipped: result?.skipped || false,
      reason: result?.reason || "",
    });

    return result;
  } catch (error) {
    console.error("ERRO AO CRIAR CONDIÇÃO DE ATIVAÇÃO:", {
      source,
      orderId: order?.id || null,
      orderNumber: order?.order_number || null,
      error: error?.message || String(error),
    });

    return {
      success: false,
      created: false,
      skipped: false,
      reason: "activation_offer_unexpected_error",
      error: error?.message || String(error),
    };
  }
}




async function createAffiliateConversionForPaidOrder(order) {
  if (!order?.id || !order?.affiliate_id) {
    return {
      created: false,
      skipped: true,
      reason: "order_without_affiliate"
    };
  }

  const checkUrl = new URL(`${env.supabaseUrl}/rest/v1/affiliate_conversions`);
  checkUrl.searchParams.set("select", "id");
  checkUrl.searchParams.set("order_id", `eq.${order.id}`);
  checkUrl.searchParams.set("limit", "1");

  const checkResponse = await fetch(checkUrl.toString(), {
    method: "GET",
    headers: {
      apikey: env.supabaseServiceRoleKey,
      Authorization: `Bearer ${env.supabaseServiceRoleKey}`,
      "Content-Type": "application/json",
      Accept: "application/json"
    }
  });

  const checkData = await checkResponse.json().catch(() => []);

  if (checkResponse.ok && Array.isArray(checkData) && checkData[0]?.id) {
    return {
      created: false,
      skipped: true,
      reason: "conversion_already_exists",
      conversionId: checkData[0].id
    };
  }

  const orderTotal = Number(order.total_amount || 0) || 0;
  const commissionRate = Number(order.affiliate_commission_rate || 0) || 0;
  const commissionAmount = Number(
    ((orderTotal * commissionRate) / 100).toFixed(2)
  );

  if (commissionRate <= 0 || commissionAmount <= 0) {
    return {
      created: false,
      skipped: true,
      reason: "invalid_commission"
    };
  }

  const payload = {
    affiliate_id: order.affiliate_id,
    order_id: order.id,
    customer_id: null,
    ref_code: order.affiliate_ref_code || "",
    coupon_code: order.affiliate_coupon_code || "",
    order_total: orderTotal,
    commission_rate: commissionRate,
    commission_amount: commissionAmount,
    status: "approved",
    approved_at: new Date().toISOString(),
    released_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    notes: `ComissÃ£o criada automaticamente pelo pedido ${order.order_number || order.id}.`
  };

  const createResponse = await fetch(`${env.supabaseUrl}/rest/v1/affiliate_conversions`, {
    method: "POST",
    headers: {
      apikey: env.supabaseServiceRoleKey,
      Authorization: `Bearer ${env.supabaseServiceRoleKey}`,
      "Content-Type": "application/json",
      Prefer: "return=representation"
    },
    body: JSON.stringify(payload)
  });

      const createData = await createResponse.json().catch(() => []);

  if (!createResponse.ok || !Array.isArray(createData) || !createData[0]?.id) {
    throw new Error("Erro ao criar comissÃ£o do afiliado");
  }

  const conversion = createData[0];

  try {
    const affiliateUrl = new URL(`${env.supabaseUrl}/rest/v1/affiliates`);
    affiliateUrl.searchParams.set("select", "*");
    affiliateUrl.searchParams.set("id", `eq.${order.affiliate_id}`);
    affiliateUrl.searchParams.set("limit", "1");

    const affiliateResponse = await fetch(affiliateUrl.toString(), {
      method: "GET",
      headers: {
        apikey: env.supabaseServiceRoleKey,
        Authorization: `Bearer ${env.supabaseServiceRoleKey}`,
        "Content-Type": "application/json",
        Accept: "application/json"
      }
    });

    const affiliateData = await affiliateResponse.json().catch(() => []);

    if (affiliateResponse.ok && Array.isArray(affiliateData) && affiliateData[0]?.email) {
      await notifyAffiliateCommissionCreated(affiliateData[0], {
        ...conversion,
        order_number: order.order_number || order.id
      });
    } else {
      console.warn("NOTIFICAÇÃO DE COMISSÃO DO AFILIADO IGNORADA: afiliado não encontrado", {
        affiliateId: order.affiliate_id,
        orderId: order.id,
        orderNumber: order.order_number
      });
    }
  } catch (notificationError) {
    console.error(
      "ERRO AO ENVIAR NOTIFICAÇÃO DE COMISSÃO DO AFILIADO:",
      notificationError
    );
  }

  return {
    created: true,
    skipped: false,
    conversion
  };
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

function getMetaPixelId() {
  return String(
    env.metaPixelId ||
      process.env.META_PIXEL_ID ||
      ""
  ).trim();
}

function getMetaConversionsApiAccessToken() {
  return String(
    env.metaConversionsApiAccessToken ||
      process.env.META_CONVERSIONS_API_ACCESS_TOKEN ||
      ""
  ).trim();
}

function getMetaApiVersion() {
  return String(
    env.metaApiVersion ||
      process.env.META_API_VERSION ||
      "v22.0"
  ).trim();
}

function sha256Normalize(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return "";
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

function hashPhoneForMeta(value) {
  const digits = onlyDigits(value);
  if (!digits) return "";
  return crypto.createHash("sha256").update(digits).digest("hex");
}

function buildMetaUserData(order) {
  const email = String(order?.customer_email || "").trim().toLowerCase();
  const phone = String(order?.customer_phone || "").trim();
  const firstName = String(order?.customer_name || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)[0] || "";
  const lastNameParts = String(order?.customer_name || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const lastName =
    lastNameParts.length > 1 ? lastNameParts[lastNameParts.length - 1] : "";

  const city = String(order?.shipping_city || "").trim().toLowerCase();
  const state = String(order?.shipping_state || "").trim().toLowerCase();
  const zip = onlyDigits(order?.shipping_cep || "");
  const country = "br";

  const userData = {};

  if (email) userData.em = [sha256Normalize(email)];
  if (phone) userData.ph = [hashPhoneForMeta(phone)];
  if (firstName) userData.fn = [sha256Normalize(firstName)];
  if (lastName) userData.ln = [sha256Normalize(lastName)];
  if (city) userData.ct = [sha256Normalize(city)];
  if (state) userData.st = [sha256Normalize(state)];
  if (zip) userData.zp = [sha256Normalize(zip)];
  if (country) userData.country = [sha256Normalize(country)];

  return userData;
}

async function sendMetaPurchaseEvent({ order, items = [], payment }) {
  try {
    const pixelId = getMetaPixelId();
    const accessToken = getMetaConversionsApiAccessToken();
    const apiVersion = getMetaApiVersion();

    if (!pixelId || !accessToken) {
      console.log(
        "META PURCHASE SKIPPED: META_PIXEL_ID ou META_CONVERSIONS_API_ACCESS_TOKEN nÃ£o configurado"
      );
      return {
        sent: false,
        skipped: true,
        reason: "meta_not_configured"
      };
    }

    const totalValue = Number(order?.total_amount || 0) || 0;
    const eventId = `purchase_${String(order?.order_number || "")}_${String(payment?.id || "")}`.trim();

    const payload = {
      data: [
        {
          event_name: "Purchase",
          event_time: Math.floor(Date.now() / 1000),
          action_source: "website",
          event_id: eventId,
          user_data: buildMetaUserData(order),
          custom_data: {
            currency: "BRL",
            value: totalValue,
            order_id: String(order?.order_number || ""),
            content_type: "product",
            content_ids: items
              .map((item) => String(item?.product_id || item?.id || "").trim())
              .filter(Boolean),
            contents: items
              .map((item) => ({
                id: String(item?.product_id || item?.id || "").trim(),
                quantity: Number(item?.quantity || 1) || 1,
                item_price: Number(item?.unit_price || 0) || 0
              }))
              .filter((item) => item.id)
          }
        }
      ]
    };

    if (process.env.META_TEST_EVENT_CODE) {
      payload.test_event_code = String(process.env.META_TEST_EVENT_CODE).trim();
    }

    const url = `https://graph.facebook.com/${apiVersion}/${pixelId}/events?access_token=${encodeURIComponent(accessToken)}`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      console.error("ERRO AO ENVIAR PURCHASE PARA META:", data);
      return {
        sent: false,
        skipped: false,
        error: data
      };
    }

    console.log("PURCHASE ENVIADO PARA META COM SUCESSO:", data);

    return {
      sent: true,
      skipped: false,
      response: data
    };
  } catch (error) {
    console.error("ERRO INTERNO AO ENVIAR PURCHASE PARA META:", error);
    return {
      sent: false,
      skipped: false,
      error: error.message || String(error)
    };
  }
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
        serviceName: serviceName || "ServiÃ§o",
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
    throw new Error("FRENET_TOKEN nÃ£o configurado");
  }

  if (!config.originZipCode) {
    throw new Error("FRENET_ORIGIN_ZIP_CODE nÃ£o configurado");
  }

  const destinationZipCode = onlyDigits(zipCode);

  if (!destinationZipCode || destinationZipCode.length < 8) {
    throw new Error("CEP de destino invÃ¡lido");
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
    throw new Error("Erro ao carregar produtos para validaÃ§Ã£o do pedido");
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
    throw new Error("E-mail do cliente Ã© obrigatÃ³rio");
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
    throw new Error("MERCADO_PAGO_ACCESS_TOKEN nÃ£o configurado");
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
    throw new Error("Pedido nÃ£o encontrado pelo external_reference");
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

      const serviceName = String(service?.name || "ServiÃ§o").trim();
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
    throw new Error("CEP de origem da loja nÃ£o configurado");
  }

  if (!destinationZipCode || destinationZipCode.length < 8) {
    throw new Error("CEP de destino invÃ¡lido");
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

function resolveSelectedShippingServiceCode(selectedShipping = {}) {
  const direct = String(selectedShipping?.serviceCode || "").trim();
  const directNumber = Number(direct);

  if (Number.isFinite(directNumber) && directNumber > 0) {
    return String(directNumber);
  }

  const raw = selectedShipping?.raw || {};
  const candidates = [
    raw?.id,
    raw?.Id,
    raw?.serviceCode,
    raw?.service_code,
    raw?.ServiceCode,
    raw?.Code
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean);

  for (const candidate of candidates) {
    const numeric = Number(candidate);
    if (Number.isFinite(numeric) && numeric > 0) {
      return String(numeric);
    }
  }

  return direct;
}

async function validateSelectedShippingQuote({
  zipCode,
  items,
  subtotal,
  selectedShipping
}) {
  const selectedServiceCode = resolveSelectedShippingServiceCode(selectedShipping);
  const selectedPrice = Number(selectedShipping?.price || 0) || 0;

  if (!selectedServiceCode) {
    throw new Error("ServiÃ§o de frete nÃ£o selecionado");
  }

  if (selectedPrice <= 0) {
    throw new Error("Valor de frete invÃ¡lido");
  }

  const provider = getShippingProvider();

  const result =
    provider === "melhor_envio"
      ? await quoteShippingWithMelhorEnvio({ zipCode, items })
      : await quoteShippingWithFrenet({ zipCode, items, subtotal });

  const quotes = Array.isArray(result.quotes) ? result.quotes : [];

  const matchedQuote = quotes.find((quote) => {
    const quoteCode = String(quote.serviceCode || "").trim();
    return quoteCode === String(selectedServiceCode || "").trim();
  });

  if (!matchedQuote) {
    throw new Error("ServiÃ§o de frete invÃ¡lido ou expirado");
  }

  const realPrice = Number(matchedQuote.price || 0) || 0;

  if (realPrice <= 0) {
    throw new Error("Valor real de frete invÃ¡lido");
  }

  const priceDifference = Math.abs(realPrice - selectedPrice);

  if (priceDifference > 0.05) {
    throw new Error("Valor de frete divergente. Recalcule o frete.");
  }

  return {
    provider,
    quote: matchedQuote,
    raw: result.raw || null
  };
}

function buildShippingQuoteRawForOrder(selectedShipping = {}) {
  const raw = selectedShipping?.raw || null;

  return {
    ...(raw && typeof raw === "object" ? raw : {}),
    selected_service_code_front: String(selectedShipping?.serviceCode || "").trim(),
    selected_service_name_front: String(selectedShipping?.serviceName || "").trim(),
    selected_carrier_front: String(selectedShipping?.carrier || "").trim(),
    selected_price_front: Number(selectedShipping?.price || 0) || 0,
    selected_delivery_time_front:
      Number(selectedShipping?.deliveryTime || 0) || 0
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
        message: "Produto nÃ£o encontrado"
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
        message: "CEP Ã© obrigatÃ³rio"
      });
    }

    if (!items.length) {
      return res.status(400).json({
        success: false,
        message: "Itens do carrinho sÃ£o obrigatÃ³rios"
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
          `Produto invÃ¡lido no pedido: ${ref || "sem referÃªncia"}`
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
    const affiliateRef = normalizeAffiliateCode(body.affiliateRef || body.affiliate_ref || "");
    const affiliate = await findActiveAffiliateByRef(affiliateRef);

    if (!customer.nome || !customer.email || !customer.telefone) {
      return res.status(400).json({
        success: false,
        message: "Nome, e-mail e telefone sÃ£o obrigatÃ³rios"
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
          `Produto invÃ¡lido no pedido: ${ref || "sem referÃªncia"}`
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

    const validatedShipping = await validateSelectedShippingQuote({
      zipCode: customer.cep,
      items: normalizedItems,
      subtotal,
      selectedShipping
    });

    const validatedShippingQuote = validatedShipping.quote;

    const resolvedShippingServiceCode = String(
      validatedShippingQuote.serviceCode || ""
    ).trim();

    const shippingAmount = Number(validatedShippingQuote.price || 0) || 0;

    // SeguranÃ§a: nÃ£o aceitar desconto vindo direto do frontend.
    // Quando houver cupom, validar o cupom no backend antes de aplicar desconto.
    const discountAmount = 0;

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
      shipping_service_code: String(resolvedShippingServiceCode || "").trim(),
      shipping_service_name: String(selectedShipping.serviceName || "").trim(),
      shipping_delivery_time: Number(selectedShipping.deliveryTime || 0) || null,
      shipping_quote_raw: buildShippingQuoteRawForOrder(selectedShipping),
      shipping_label_status: "pending",
      subtotal,
      shipping_amount: shippingAmount,
      discount_amount: discountAmount,
      total_amount: totalAmount,

      affiliate_id: affiliate?.id || null,
      affiliate_ref_code: affiliate?.ref_code || affiliateRef || "",
      affiliate_coupon_code: affiliate?.coupon_code || "",
      affiliate_commission_rate: affiliate?.commission_rate
        ? Number(affiliate.commission_rate)
        : null,
      affiliate_commission_amount: affiliate?.commission_rate
        ? Number(((totalAmount * Number(affiliate.commission_rate || 0)) / 100).toFixed(2))
        : null,

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

    try {
      await notifyOrderCreatedPending(createdOrder);
    } catch (notificationError) {
      console.error("ERRO AO ENVIAR NOTIFICAÇÃO DE PEDIDO PENDENTE:", notificationError);
    }


   if (isPaymentSimulationEnabled()) {
  const simulatedPaymentUrl = new URL(
    "https://ozonteck-loja.onrender.com/pages-html/pagamento-simulado.html"
  );

  simulatedPaymentUrl.searchParams.set(
    "external_reference",
    String(createdOrder.order_number || "")
  );

  simulatedPaymentUrl.searchParams.set(
    "order_number",
    String(createdOrder.order_number || "")
  );

  return res.status(201).json({
    success: true,
    message: "Pedido criado com sucesso. Aguardando pagamento simulado.",
    order: {
      id: createdOrder.id,
      number: createdOrder.order_number,
      total: totalAmount,
      status: createdOrder.order_status,
      paymentStatus: createdOrder.payment_status
    },
    payment: {
      gateway: "simulation_page",
      preferenceId: "",
      paymentUrl: simulatedPaymentUrl.toString(),
      sandboxPaymentUrl: simulatedPaymentUrl.toString(),
      externalReference: createdOrder.order_number
    }
  });
}

const accessToken = getMercadoPagoAccessToken();

if (!accessToken) {
  return res.status(500).json({
    success: false,
    message:
      "MERCADO_PAGO_ACCESS_TOKEN não configurado. Ative ENABLE_PAYMENT_SIMULATION=true para testar sem Mercado Pago."
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
          "Pedido criado, mas houve erro ao salvar a referÃªncia de pagamento",
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
          message: "Assinatura invÃ¡lida do webhook"
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

    let previousOrder = null;

    try {
      previousOrder = await findOrderByExternalReference(externalReference);
    } catch (previousOrderError) {
      console.warn(
        "NÃƒO FOI POSSÃVEL BUSCAR ESTADO ANTERIOR DO PEDIDO ANTES DO UPDATE:",
        previousOrderError.message || previousOrderError
      );
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
    let metaPurchaseResult = null;
    let affiliateConversionResult = null;
    let activationOfferResult = null;

    if (paymentStatus === "approved") {
      try {
        const updatedOrder =
          Array.isArray(updateResponse.data) && updateResponse.data[0]
            ? updateResponse.data[0]
            : await findOrderByExternalReference(externalReference);

        const orderItems = await findOrderItems(updatedOrder.id);


        activationOfferResult = await createActivationOfferSafely(
  updatedOrder,
  "mercado_pago_webhook"
);

const alreadyPaidBeforeWebhook =
  String(previousOrder?.payment_status || "").trim().toLowerCase() === "paid";

if (!alreadyPaidBeforeWebhook) {
  try {
    affiliateConversionResult = await createAffiliateConversionForPaidOrder(updatedOrder);
  } catch (affiliateError) {
    console.error("ERRO AO CRIAR COMISSÃO DO AFILIADO:", affiliateError);

    affiliateConversionResult = {
      created: false,
      skipped: false,
      error: affiliateError.message || "Erro ao criar comissão do afiliado",
    };
  }
} else {
        affiliateConversionResult = {
          created: false,
          skipped: true,
          reason: "already_paid_before_webhook"
        };
      }

                if (!alreadyPaidBeforeWebhook) {
          metaPurchaseResult = await sendMetaPurchaseEvent({
            order: updatedOrder,
            items: orderItems,
            payment
          });

          try {
            await notifyOrderPaid(updatedOrder);
          } catch (notificationError) {
            console.error("ERRO AO ENVIAR NOTIFICAÇÃO DE PEDIDO PAGO:", notificationError);
          }
        } else {
          metaPurchaseResult = {
            sent: false,
            skipped: true,
            reason: "already_paid_before_webhook"
          };
        }

        if (updatedOrder?.shipping_label_status !== "generated") {
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
        console.error("ERRO AO GERAR ETIQUETA AUTOMÃTICA:", labelError);

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
  message: "Webhook Mercado Pago processado com sucesso",
  received: true,
  paymentStatus,
  externalReference,
  label: labelResult,
  metaPurchase: metaPurchaseResult,
  affiliateConversion: affiliateConversionResult,
  activationOffer: activationOfferResult
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
        message: "SimulaÃ§Ã£o de pagamento desativada"
      });
    }

    const orderNumber = String(req.params.orderNumber || "").trim();
    const status = String(req.body?.status || "approved")
      .trim()
      .toLowerCase();

    if (!orderNumber) {
      return res.status(400).json({
        success: false,
        message: "NÃºmero do pedido Ã© obrigatÃ³rio"
      });
    }

    let previousOrder = null;

    try {
      previousOrder = await findOrderByExternalReference(orderNumber);
    } catch (previousOrderError) {
      console.warn(
        "NÃƒO FOI POSSÃVEL BUSCAR ESTADO ANTERIOR DO PEDIDO ANTES DA SIMULAÃ‡ÃƒO:",
        previousOrderError.message || previousOrderError
      );
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

  } else if (status === "failed" || status === "rejected" || status === "cancelled") {
  updatePayload.payment_status = "pending";
  updatePayload.payment_raw_status = status === "cancelled" ? "cancelled" : "rejected";
  updatePayload.order_status = "pending";
} else {

      return res.status(400).json({
        success: false,
        message: "Status invÃ¡lido para simulaÃ§Ã£o"
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
        let metaPurchaseResult = null;
        let affiliateConversionResult = null;
        let activationOfferResult = null;

      if ((status === "approved" || status === "paid") && updatedOrder?.id) {
        try {
          const orderItems = await findOrderItems(updatedOrder.id);

          const alreadyPaidBeforeSimulation =
            String(previousOrder?.payment_status || "").trim().toLowerCase() === "paid";

          if (!alreadyPaidBeforeSimulation) {
  try {
  affiliateConversionResult = await createAffiliateConversionForPaidOrder(updatedOrder);
} catch (affiliateError) {
  console.error("ERRO AO CRIAR COMISSÃO DO AFILIADO NA SIMULAÇÃO:", affiliateError);

  affiliateConversionResult = {
    created: false,
    skipped: false,
    error: affiliateError.message || "Erro ao criar comissão do afiliado na simulação",
  };
}

activationOfferResult = await createActivationOfferSafely(
  updatedOrder,
  "payment_simulation"
);

metaPurchaseResult = await sendMetaPurchaseEvent({
    order: updatedOrder,
    items: orderItems,
    payment: {
      id: `simulation_${updatedOrder.order_number}`
    }
  });

  try {
    await notifyOrderPaid(updatedOrder);
  } catch (notificationError) {
    console.error("ERRO AO ENVIAR NOTIFICAÇÃO DE PEDIDO PAGO NA SIMULAÇÃO:", notificationError);
  }
} else {

  affiliateConversionResult = {
    created: false,
    skipped: true,
    reason: "already_paid_before_simulation"
  };

  metaPurchaseResult = {
    sent: false,
    skipped: true,
    reason: "already_paid_before_simulation"
  };
}

          if (updatedOrder.shipping_label_status !== "generated") {
            const generatedLabel = await generateAutomaticShippingLabel(
              updatedOrder,
              orderItems
            );
            await saveGeneratedLabel(updatedOrder.id, generatedLabel);
          }
        } catch (labelError) {
          console.error("ERRO AO GERAR ETIQUETA NA SIMULAÃ‡ÃƒO:", labelError);
          await saveLabelError(
            updatedOrder.id,
            labelError.message || "Erro ao gerar etiqueta na simulaÃ§Ã£o"
          );
        }
      }

     return res.status(200).json({
  success: true,
  message: "Pagamento simulado com sucesso",
  order: updatedOrder,
  metaPurchase: metaPurchaseResult,
  affiliateConversion: affiliateConversionResult,
  activationOffer: activationOfferResult
});
    }

    const findUrl = new URL(`${env.supabaseUrl}/rest/v1/orders`);
    findUrl.searchParams.set("order_number", `eq.${orderNumber}`);
    findUrl.searchParams.set("select", "id,order_number,shipping_label_status,payment_status");
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
        message: "Pedido nÃ£o encontrado para simulaÃ§Ã£o",
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
        message: "Erro ao atualizar pedido na simulaÃ§Ã£o",
        details: fallbackUpdate.raw
      });
    }

    const updatedOrder = fallbackUpdate.data[0];
    let metaPurchaseResult = null;
    let affiliateConversionResult = null;
    let activationOfferResult = null;


        async function notifySimulationPaymentStatus(order) {
      try {
        if (status === "approved" || status === "paid") {
          await notifyOrderPaid(order);
          return;
        }

        if (status === "pending") {
          await notifyOrderPaymentPending(order);
          return;
        }

        if (status === "failed" || status === "rejected" || status === "cancelled") {
          await notifyOrderPaymentFailed(order);
        }
      } catch (notificationError) {
        console.error("ERRO AO ENVIAR NOTIFICAÇÃO DE STATUS DE PAGAMENTO NA SIMULAÇÃO:", notificationError);
      }
    }

    if ((status === "approved" || status === "paid") && updatedOrder?.id) {
      try {
        const orderItems = await findOrderItems(updatedOrder.id);

          activationOfferResult = await createActivationOfferSafely(
            updatedOrder,
            "payment_simulation_fallback"
          );


    const alreadyPaidBeforeSimulation =
  String(previousOrder?.payment_status || "").trim().toLowerCase() === "paid";

activationOfferResult = await createActivationOfferSafely(
  updatedOrder,
  "payment_simulation"
);

if (!alreadyPaidBeforeSimulation) {
  try {
    affiliateConversionResult = await createAffiliateConversionForPaidOrder(updatedOrder);
  } catch (affiliateError) {
    console.error("ERRO AO CRIAR COMISSÃO DO AFILIADO NA SIMULAÇÃO:", affiliateError);

    affiliateConversionResult = {
      created: false,
      skipped: false,
      error: affiliateError.message || "Erro ao criar comissão do afiliado na simulação",
    };
  }

  metaPurchaseResult = await sendMetaPurchaseEvent({
    order: updatedOrder,
    items: orderItems,
    payment: {
      id: `simulation_${updatedOrder.order_number}`
    }
  });

  try {
    await notifyOrderPaid(updatedOrder);
  } catch (notificationError) {
    console.error("ERRO AO ENVIAR NOTIFICAÇÃO DE PEDIDO PAGO NA SIMULAÇÃO:", notificationError);
  }
} else {

  affiliateConversionResult = {
    created: false,
    skipped: true,
    reason: "already_paid_before_simulation"
  };

  metaPurchaseResult = {
    sent: false,
    skipped: true,
    reason: "already_paid_before_simulation"
  };
}

        if (updatedOrder.shipping_label_status !== "generated") {
          const generatedLabel = await generateAutomaticShippingLabel(
            updatedOrder,
            orderItems
          );
          await saveGeneratedLabel(updatedOrder.id, generatedLabel);
        }
      } catch (labelError) {
        console.error(
          "ERRO AO GERAR ETIQUETA NO FALLBACK DA SIMULAÃ‡ÃƒO:",
          labelError
        );
        await saveLabelError(
          updatedOrder.id,
          labelError.message || "Erro ao gerar etiqueta na simulaÃ§Ã£o"
        );
      }
    }

    if (status === "pending" || status === "failed" || status === "rejected" || status === "cancelled") {
      await notifySimulationPaymentStatus(updatedOrder);
    }


    return res.status(200).json({
  success: true,
  message: "Pagamento simulado com sucesso",
  order: updatedOrder,
  metaPurchase: metaPurchaseResult,
  affiliateConversion: affiliateConversionResult,
  activationOffer: activationOfferResult
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
        message: "NÃºmero do pedido Ã© obrigatÃ³rio"
      });
    }

    const url = new URL(`${env.supabaseUrl}/rest/v1/orders`);
    url.searchParams.set("order_number", `eq.${orderNumber}`);
    url.searchParams.set(
      "select",
      "id,order_number,payment_status,payment_raw_status,order_status,tracking_code,paid_at,payment_gateway,payment_external_reference,shipping_label_status,shipping_label_url,shipping_label_pdf_url,shipping_tracking_code,shipping_shipment_id,shipping_label_generated_at,shipping_label_error,shipping_service_code,shipping_service_name,shipping_quote_raw"
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
        message: "Pedido nÃ£o encontrado"
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

router.post("/orders/:id/process-paid", requireAdminAuth, async (req, res) => {
  try {
    const result = await processPaidOrder({ orderId: req.params.id });

    return res.status(200).json({
      success: true,
      result
    });
  } catch (error) {
    console.error("PROCESS PAID ORDER ERROR:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Erro ao processar pedido pago"
    });
  }
});

router.get("/melhor-envio/authorize-url", async (req, res) => {
  try {
    return res.status(200).json({
      success: true,
      url: buildMelhorEnvioAuthorizeUrl()
    });
  } catch (error) {
    console.error("ERRO AO GERAR URL DE AUTORIZAÃ‡ÃƒO DO MELHOR ENVIO:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Erro ao gerar URL de autorizaÃ§Ã£o"
    });
  }
});

router.post("/affiliates/apply", async (req, res) => {
  try {
    const result = await createAffiliateApplication(req.body || {});

    if (result.alreadyExists) {
      return res.status(200).json({
        success: true,
        alreadyExists: true,
        message:
          "VocÃª jÃ¡ possui uma solicitaÃ§Ã£o de afiliado pendente. Aguarde a anÃ¡lise da equipe OZONTECK.",
        application: result.application,
      });
    }

    return res.status(201).json({
      success: true,
      alreadyExists: false,
      message:
        "SolicitaÃ§Ã£o enviada com sucesso. Nossa equipe vai analisar seu cadastro de afiliado.",
      application: result.application,
    });
  } catch (error) {
    console.error("ERRO AO CRIAR SOLICITAÃ‡ÃƒO DE AFILIADO:", error);

    return res.status(400).json({
      success: false,
      message: error.message || "Erro ao enviar solicitaÃ§Ã£o de afiliado.",
    });
  }
});

router.get("/health", async (req, res) => {
  return res.status(200).json({
    success: true,
    message: "Camada pÃºblica da loja ativa"
  });
});

export default router;

