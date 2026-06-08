import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";

import { env } from "../config/env.js";

const router = express.Router();
const CUSTOMER_TOKEN_EXPIRES_IN = "30d";
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const OAUTH_PROVIDER_LABELS = {
  google: "Google",
  facebook: "Facebook",
};


function cleanText(value) {
  return String(value || "").trim();
}

function onlyDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

function normalizeEmail(value) {
  return cleanText(value).toLowerCase();
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanText(value));
}

function normalizePhone(value) {
  const digits = onlyDigits(value);

  if (!digits) {
    return "";
  }

  if (digits.startsWith("55") && digits.length >= 12) {
    return digits;
  }

  if (digits.length >= 10 && digits.length <= 11) {
    return `55${digits}`;
  }

  return digits;
}

function parseBrazilianDate(value) {
  const raw = cleanText(value);

  if (!raw) {
    return null;
  }

  const isoMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    return raw;
  }

  const brMatch = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!brMatch) {
    return null;
  }

  const [, day, month, year] = brMatch;
  const date = new Date(`${year}-${month}-${day}T00:00:00.000Z`);

  if (
    Number.isNaN(date.getTime()) ||
    date.getUTCFullYear() !== Number(year) ||
    date.getUTCMonth() + 1 !== Number(month) ||
    date.getUTCDate() !== Number(day)
  ) {
    return null;
  }

  return `${year}-${month}-${day}`;
}

function getRequestData(req = {}) {
  const body = req.body || {};

  return {
    fullName: cleanText(
      body.full_name || body.fullName || body.nome || body.name
    ),
    email: normalizeEmail(body.email),
    phone: cleanText(body.phone || body.telefone),
    cpf: onlyDigits(body.cpf),
    birthDate: parseBrazilianDate(
      body.birth_date || body.birthDate || body.nascimento || body.data_nascimento
    ),
    password: String(body.password || body.senha || ""),
    passwordConfirm: String(
      body.password_confirm ||
        body.passwordConfirm ||
        body.confirmar_senha ||
        body.confirmarSenha ||
        body.confirmar ||
        ""
    ),
    newsletterOptIn: Boolean(body.newsletter_opt_in || body.newsletterOptIn),
  };
}

function validateRegisterInput(data) {
  if (!data.fullName || data.fullName.length < 3) {
    return "Informe seu nome completo.";
  }

  if (!data.email || !isValidEmail(data.email)) {
    return "Informe um e-mail válido.";
  }

  if (!data.password || data.password.length < 6) {
    return "A senha precisa ter pelo menos 6 caracteres.";
  }

  if (data.passwordConfirm && data.password !== data.passwordConfirm) {
    return "As senhas não conferem.";
  }

  return "";
}

function validateLoginInput(email, password) {
  if (!email || !isValidEmail(email)) {
    return "Informe um e-mail válido.";
  }

  if (!password) {
    return "Informe sua senha.";
  }

  return "";
}

function getSupabaseHeaders(extra = {}) {
  return {
    apikey: env.supabaseServiceRoleKey,
    Authorization: `Bearer ${env.supabaseServiceRoleKey}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    ...extra,
  };
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => null);

  return {
    ok: response.ok,
    status: response.status,
    data,
  };
}

function customerSelectColumns() {
  return [
    "id",
    "full_name",
    "email",
    "phone",
    "cpf",
    "birth_date",
    "city",
    "state",
    "origin",
    "status",
    "notes",
    "password_hash",
    "account_enabled",
    "newsletter_opt_in",
    "last_login_at",
    "created_at",
    "updated_at",
  ].join(",");
}

async function findCustomerByEmail(email) {
  const url = new URL(`${env.supabaseUrl}/rest/v1/customers`);
  url.searchParams.set("select", customerSelectColumns());
  url.searchParams.set("email", `eq.${email}`);
  url.searchParams.set("limit", "1");

  const result = await fetchJson(url.toString(), {
    method: "GET",
    headers: getSupabaseHeaders(),
  });

  if (!result.ok) {
    throw new Error("Erro ao buscar cliente no banco de dados.");
  }

  return Array.isArray(result.data) ? result.data[0] || null : null;
}

async function findCustomerById(id) {
  const url = new URL(`${env.supabaseUrl}/rest/v1/customers`);
  url.searchParams.set("select", customerSelectColumns());
  url.searchParams.set("id", `eq.${id}`);
  url.searchParams.set("limit", "1");

  const result = await fetchJson(url.toString(), {
    method: "GET",
    headers: getSupabaseHeaders(),
  });

  if (!result.ok) {
    throw new Error("Erro ao buscar cliente autenticado.");
  }

  return Array.isArray(result.data) ? result.data[0] || null : null;
}

function mapCustomer(customer = {}) {
  return {
    id: customer.id,
    name: customer.full_name || "Cliente",
    fullName: customer.full_name || "Cliente",
    email: customer.email || "",
    phone: customer.phone || "",
    telefone: customer.phone || "",
    cpf: customer.cpf || "",
    nascimento: customer.birth_date || "",
    birthDate: customer.birth_date || "",
    city: customer.city || "",
    state: customer.state || "",
    status: customer.status || "lead",
    origin: customer.origin || "Site",
    accountEnabled: Boolean(customer.account_enabled),
    newsletterOptIn: Boolean(customer.newsletter_opt_in),
    lastLoginAt: customer.last_login_at || null,
    createdAt: customer.created_at || null,
  };
}

function signCustomerToken(customer = {}) {
  return jwt.sign(
    {
      type: "customer",
      customer_id: customer.id,
      email: customer.email,
    },
    env.jwtSecret,
    { expiresIn: CUSTOMER_TOKEN_EXPIRES_IN }
  );
}

function buildAuthResponse(customer, message) {
  const token = signCustomerToken(customer);

  return {
    success: true,
    message,
    token,
    customer: mapCustomer(customer),
  };
}

function base64UrlEncode(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(String(value));

  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlDecode(value) {
  const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");

  return Buffer.from(padded, "base64").toString("utf8");
}

function normalizeUrlWithoutTrailingSlash(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function getStoreFrontendBaseUrl() {
  return normalizeUrlWithoutTrailingSlash(
    process.env.STORE_FRONTEND_URL ||
      process.env.STORE_URL ||
      env.frontendUrl ||
      "https://ozonteck-loja.onrender.com"
  );
}

function getDefaultStoreLoginUrl() {
  const base = getStoreFrontendBaseUrl();

  if (/\/pages-html\/login\.html$/i.test(base)) {
    return base;
  }

  if (/\/pages-html$/i.test(base)) {
    return `${base}/login.html`;
  }

  return `${base}/pages-html/login.html`;
}

function getAllowedLoginHosts() {
  const urls = [
    process.env.STORE_FRONTEND_URL,
    process.env.STORE_URL,
    env.frontendUrl,
    "https://ozonteck-loja.onrender.com",
  ];

  return urls
    .map((value) => {
      try {
        return new URL(String(value || "")).hostname;
      } catch {
        return "";
      }
    })
    .filter(Boolean);
}

function isLocalDevelopmentHost(hostname) {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "0.0.0.0" ||
    hostname.startsWith("192.168.") ||
    hostname.startsWith("10.")
  );
}

function sanitizeLoginUrl(value) {
  const fallback = getDefaultStoreLoginUrl();
  const raw = cleanText(value);

  if (!raw) {
    return fallback;
  }

  try {
    const url = new URL(raw);
    const allowedHosts = getAllowedLoginHosts();

    if (!["http:", "https:"].includes(url.protocol)) {
      return fallback;
    }

    if (!isLocalDevelopmentHost(url.hostname) && !allowedHosts.includes(url.hostname)) {
      return fallback;
    }

    url.hash = "";
    return url.toString();
  } catch {
    return fallback;
  }
}

function sanitizeRelativeRedirect(value) {
  const raw = cleanText(value);

  if (!raw) {
    return "./conta.html";
  }

  if (raw.length > 500) {
    return "./conta.html";
  }

  if (/^https?:\/\//i.test(raw) || raw.includes("..")) {
    return "./conta.html";
  }

  if (!raw.startsWith("./") && !raw.startsWith("/") && !raw.startsWith("pages-html/")) {
    return "./conta.html";
  }

  return raw;
}

function getApiPublicBaseUrl(req) {
  const configured = normalizeUrlWithoutTrailingSlash(
    process.env.PUBLIC_API_URL ||
      process.env.API_PUBLIC_URL ||
      process.env.API_BASE_URL ||
      env.apiBaseUrl ||
      process.env.RENDER_EXTERNAL_URL ||
      ""
  );

  if (/^https?:\/\//i.test(configured)) {
    return configured.replace(/\/api$/i, "");
  }

  const forwardedProto = String(req.get("x-forwarded-proto") || "").split(",")[0].trim();
  const forwardedHost = String(req.get("x-forwarded-host") || "").split(",")[0].trim();
  const protocol = forwardedProto || req.protocol || "https";
  const host = forwardedHost || req.get("host");

  return `${protocol}://${host}`.replace(/\/+$/, "");
}

function getOAuthRedirectUri(req, provider) {
  return `${getApiPublicBaseUrl(req)}/api/store/customer/oauth/${provider}/callback`;
}

function getProviderCredentials(provider) {
  if (provider === "google") {
    return {
      clientId: process.env.GOOGLE_CLIENT_ID || "",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
    };
  }

  if (provider === "facebook") {
    return {
      clientId: process.env.FACEBOOK_APP_ID || process.env.FACEBOOK_CLIENT_ID || "",
      clientSecret: process.env.FACEBOOK_APP_SECRET || process.env.FACEBOOK_CLIENT_SECRET || "",
    };
  }

  return { clientId: "", clientSecret: "" };
}

function signOAuthState(payload) {
  const body = base64UrlEncode(JSON.stringify(payload));
  const signature = base64UrlEncode(
    crypto.createHmac("sha256", env.jwtSecret).update(body).digest()
  );

  return `${body}.${signature}`;
}

function verifyOAuthState(state) {
  const [body, signature] = String(state || "").split(".");

  if (!body || !signature) {
    throw new Error("Sessão do login social inválida.");
  }

  const expected = base64UrlEncode(
    crypto.createHmac("sha256", env.jwtSecret).update(body).digest()
  );

  const receivedBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);

  if (
    receivedBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(receivedBuffer, expectedBuffer)
  ) {
    throw new Error("Sessão do login social expirada ou inválida.");
  }

  const payload = JSON.parse(base64UrlDecode(body));

  if (!payload?.exp || Number(payload.exp) < Date.now()) {
    throw new Error("Sessão do login social expirada. Tente novamente.");
  }

  return payload;
}

function createOAuthState(provider, req) {
  return signOAuthState({
    provider,
    redirect: sanitizeRelativeRedirect(req.query?.redirect),
    loginUrl: sanitizeLoginUrl(req.query?.login_url),
    nonce: crypto.randomBytes(16).toString("hex"),
    exp: Date.now() + OAUTH_STATE_TTL_MS,
  });
}

function buildOAuthAuthorizeUrl(provider, credentials, redirectUri, state) {
  if (provider === "google") {
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.searchParams.set("client_id", credentials.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "openid email profile");
    url.searchParams.set("state", state);
    url.searchParams.set("prompt", "select_account");
    url.searchParams.set("access_type", "online");
    return url;
  }

  if (provider === "facebook") {
    const url = new URL("https://www.facebook.com/v19.0/dialog/oauth");
    url.searchParams.set("client_id", credentials.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "email,public_profile");
    url.searchParams.set("state", state);
    return url;
  }

  throw new Error("Provedor de login social inválido.");
}

function buildLoginHash(params = {}) {
  const hash = new URLSearchParams();

  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      hash.set(key, String(value));
    }
  });

  return hash.toString();
}

function redirectToLoginWithOAuthError(res, message, stateData = {}) {
  const loginUrl = sanitizeLoginUrl(stateData?.loginUrl);
  const hash = buildLoginHash({
    social_error: "1",
    message: message || "Não foi possível concluir o login social.",
  });

  return res.redirect(302, `${loginUrl}#${hash}`);
}

function redirectToLoginWithOAuthSuccess(res, stateData, authResponse, provider) {
  const loginUrl = sanitizeLoginUrl(stateData?.loginUrl);
  const hash = buildLoginHash({
    social_login: "1",
    provider,
    customer_token: authResponse.token,
    customer: base64UrlEncode(JSON.stringify(authResponse.customer)),
    redirect: sanitizeRelativeRedirect(stateData?.redirect),
  });

  return res.redirect(302, `${loginUrl}#${hash}`);
}

async function exchangeGoogleCodeForProfile(code, credentials, redirectUri) {
  const tokenResult = await fetchJson("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      code,
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  if (!tokenResult.ok || !tokenResult.data?.access_token) {
    console.error("ERRO TOKEN GOOGLE:", tokenResult.data);
    throw new Error("Não foi possível validar o login com Google.");
  }

  const profileResult = await fetchJson("https://www.googleapis.com/oauth2/v3/userinfo", {
    method: "GET",
    headers: {
      Authorization: `Bearer ${tokenResult.data.access_token}`,
      Accept: "application/json",
    },
  });

  if (!profileResult.ok || !profileResult.data?.email) {
    console.error("ERRO PERFIL GOOGLE:", profileResult.data);
    throw new Error("O Google não retornou um e-mail válido.");
  }

  if (profileResult.data.email_verified === false) {
    throw new Error("Use uma conta Google com e-mail verificado.");
  }

  return {
    provider: "google",
    providerId: cleanText(profileResult.data.sub),
    email: normalizeEmail(profileResult.data.email),
    name: cleanText(profileResult.data.name) || cleanText(profileResult.data.email),
    avatarUrl: cleanText(profileResult.data.picture),
  };
}

async function exchangeFacebookCodeForProfile(code, credentials, redirectUri) {
  const tokenUrl = new URL("https://graph.facebook.com/v19.0/oauth/access_token");
  tokenUrl.searchParams.set("client_id", credentials.clientId);
  tokenUrl.searchParams.set("client_secret", credentials.clientSecret);
  tokenUrl.searchParams.set("redirect_uri", redirectUri);
  tokenUrl.searchParams.set("code", code);

  const tokenResult = await fetchJson(tokenUrl.toString(), {
    method: "GET",
    headers: { Accept: "application/json" },
  });

  if (!tokenResult.ok || !tokenResult.data?.access_token) {
    console.error("ERRO TOKEN FACEBOOK:", tokenResult.data);
    throw new Error("Não foi possível validar o login com Facebook.");
  }

  const profileUrl = new URL("https://graph.facebook.com/v19.0/me");
  profileUrl.searchParams.set("fields", "id,name,email,picture.type(large)");
  profileUrl.searchParams.set("access_token", tokenResult.data.access_token);

  const profileResult = await fetchJson(profileUrl.toString(), {
    method: "GET",
    headers: { Accept: "application/json" },
  });

  if (!profileResult.ok || !profileResult.data?.email) {
    console.error("ERRO PERFIL FACEBOOK:", profileResult.data);
    throw new Error("O Facebook não retornou um e-mail. Ative a permissão de e-mail no app do Facebook.");
  }

  return {
    provider: "facebook",
    providerId: cleanText(profileResult.data.id),
    email: normalizeEmail(profileResult.data.email),
    name: cleanText(profileResult.data.name) || cleanText(profileResult.data.email),
    avatarUrl: cleanText(profileResult.data.picture?.data?.url),
  };
}

async function createCustomerFromSocialProfile(profile) {
  const providerLabel = OAUTH_PROVIDER_LABELS[profile.provider] || "Login social";
  const now = new Date().toISOString();
  const payload = {
    full_name: profile.name || "Cliente",
    email: profile.email,
    phone: "",
    cpf: null,
    birth_date: null,
    origin: `Site - ${providerLabel}`,
    status: "lead",
    notes: `Conta criada pela loja usando ${providerLabel}.`,
    password_hash: null,
    account_enabled: true,
    newsletter_opt_in: false,
    last_login_at: now,
    updated_at: now,
  };

  const result = await fetchJson(`${env.supabaseUrl}/rest/v1/customers`, {
    method: "POST",
    headers: getSupabaseHeaders({ Prefer: "return=representation" }),
    body: JSON.stringify(payload),
  });

  if (!result.ok || !Array.isArray(result.data) || !result.data[0]?.id) {
    console.error("ERRO AO CRIAR CLIENTE SOCIAL:", result.data);
    throw new Error("Erro ao criar conta com login social.");
  }

  return result.data[0];
}

async function updateCustomerFromSocialProfile(customer, profile) {
  const now = new Date().toISOString();
  const providerLabel = OAUTH_PROVIDER_LABELS[profile.provider] || "Login social";
  const payload = {
    account_enabled: true,
    last_login_at: now,
    updated_at: now,
  };

  if (!cleanText(customer.full_name) || cleanText(customer.full_name).toLowerCase() === "cliente") {
    payload.full_name = profile.name || customer.full_name || "Cliente";
  }

  if (!cleanText(customer.origin)) {
    payload.origin = `Site - ${providerLabel}`;
  }

  const url = new URL(`${env.supabaseUrl}/rest/v1/customers`);
  url.searchParams.set("id", `eq.${customer.id}`);

  const result = await fetchJson(url.toString(), {
    method: "PATCH",
    headers: getSupabaseHeaders({ Prefer: "return=representation" }),
    body: JSON.stringify(payload),
  });

  if (!result.ok || !Array.isArray(result.data) || !result.data[0]?.id) {
    console.error("ERRO AO ATUALIZAR CLIENTE SOCIAL:", result.data);
    throw new Error("Erro ao atualizar conta com login social.");
  }

  return result.data[0];
}

async function getOrCreateCustomerFromSocialProfile(profile) {
  const existingCustomer = await findCustomerByEmail(profile.email);

  if (existingCustomer?.id) {
    return updateCustomerFromSocialProfile(existingCustomer, profile);
  }

  return createCustomerFromSocialProfile(profile);
}

async function createCustomerAccount(data, passwordHash) {
  const payload = {
    full_name: data.fullName,
    email: data.email,
    phone: data.phone,
    cpf: data.cpf || null,
    birth_date: data.birthDate,
    origin: "Site",
    status: "lead",
    notes: "Conta criada pela loja.",
    password_hash: passwordHash,
    account_enabled: true,
    newsletter_opt_in: data.newsletterOptIn,
    last_login_at: new Date().toISOString(),
  };

  const result = await fetchJson(`${env.supabaseUrl}/rest/v1/customers`, {
    method: "POST",
    headers: getSupabaseHeaders({ Prefer: "return=representation" }),
    body: JSON.stringify(payload),
  });

  if (!result.ok || !Array.isArray(result.data) || !result.data[0]?.id) {
    console.error("ERRO AO CRIAR CONTA DE CLIENTE:", result.data);
    throw new Error("Erro ao criar conta do cliente.");
  }

  return result.data[0];
}

async function updateCustomerAccount(customerId, data, passwordHash) {
  const payload = {
    full_name: data.fullName,
    email: data.email,
    phone: data.phone,
    cpf: data.cpf || null,
    birth_date: data.birthDate,
    status: "lead",
    password_hash: passwordHash,
    account_enabled: true,
    newsletter_opt_in: data.newsletterOptIn,
    last_login_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const url = new URL(`${env.supabaseUrl}/rest/v1/customers`);
  url.searchParams.set("id", `eq.${customerId}`);

  const result = await fetchJson(url.toString(), {
    method: "PATCH",
    headers: getSupabaseHeaders({ Prefer: "return=representation" }),
    body: JSON.stringify(payload),
  });

  if (!result.ok || !Array.isArray(result.data) || !result.data[0]?.id) {
    console.error("ERRO AO ATIVAR CONTA DE CLIENTE:", result.data);
    throw new Error("Erro ao atualizar conta do cliente.");
  }

  return result.data[0];
}

async function touchLastLogin(customerId) {
  const url = new URL(`${env.supabaseUrl}/rest/v1/customers`);
  url.searchParams.set("id", `eq.${customerId}`);

  await fetchJson(url.toString(), {
    method: "PATCH",
    headers: getSupabaseHeaders(),
    body: JSON.stringify({
      last_login_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }),
  });
}

async function requireCustomerAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization || "";

    if (!authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        message: "Cliente não autenticado.",
      });
    }

    const token = authHeader.slice("Bearer ".length).trim();
    const decoded = jwt.verify(token, env.jwtSecret);

    if (decoded.type !== "customer" || !decoded.customer_id) {
      return res.status(401).json({
        success: false,
        message: "Sessão de cliente inválida.",
      });
    }

    // Revalida a conta no banco em cada acesso protegido. Um token antigo
    // deixa de funcionar imediatamente quando a conta é desativada.
    const customer = await findCustomerById(decoded.customer_id);

    if (!customer?.id || customer.account_enabled !== true) {
      return res.status(403).json({
        success: false,
        message: "Conta de cliente desativada ou indisponível.",
      });
    }

    if (normalizeEmail(customer.email) !== normalizeEmail(decoded.email)) {
      return res.status(401).json({
        success: false,
        message: "Sessão de cliente inválida.",
      });
    }

    req.customerAuth = {
      id: customer.id,
      email: normalizeEmail(customer.email),
    };
    req.customer = customer;

    return next();
  } catch (error) {
    console.warn("[CUSTOMER_AUTH_ERROR]", {
      message: error?.message,
      name: error?.name,
    });

    return res.status(401).json({
      success: false,
      message: "Sessão expirada. Faça login novamente.",
    });
  }
}

function isPaidOrder(order) {
  const status = String(order?.payment_status || "").toLowerCase();
  return ["paid", "approved", "pago", "aprovado"].includes(status);
}

function mapOrder(order = {}) {
  return {
    id: order.id,
    orderNumber: order.order_number || "",
    totalAmount: Number(order.total_amount || 0),
    paymentStatus: order.payment_status || "",
    orderStatus: order.order_status || "",
    trackingCode: order.shipping_tracking_code || order.tracking_code || "",
    createdAt: order.created_at || null,
    paidAt: order.paid_at || null,
  };
}

async function fetchCustomerOrders(customer) {
  const email = normalizeEmail(customer.email);

  if (!email) {
    return [];
  }

  const url = new URL(`${env.supabaseUrl}/rest/v1/orders`);
  url.searchParams.set(
    "select",
    "id,order_number,total_amount,payment_status,order_status,shipping_tracking_code,tracking_code,created_at,paid_at"
  );
  url.searchParams.set("customer_email", `eq.${email}`);
  url.searchParams.set("order", "created_at.desc");
  url.searchParams.set("limit", "20");

  const result = await fetchJson(url.toString(), {
    method: "GET",
    headers: getSupabaseHeaders(),
  });

  if (!result.ok || !Array.isArray(result.data)) {
    console.error("ERRO AO BUSCAR PEDIDOS DO CLIENTE:", result.data);
    return [];
  }

  return result.data.map(mapOrder);
}

function buildAccountSummary(customer, orders = []) {
  const paidOrders = orders.filter(isPaidOrder);
  const totalSpent = paidOrders.reduce(
    (sum, order) => sum + Number(order.totalAmount || 0),
    0
  );
  const points = Math.max(0, Math.round(totalSpent));
  const nextGoal = points >= 5000 ? 10000 : 5000;
  const progress = Math.min(100, Math.round((points / nextGoal) * 100));

  return {
    totalOrders: orders.length,
    paidOrders: paidOrders.length,
    totalSpent,
    points,
    activeCoupons: 0,
    currentLevel: points >= 5000 ? "Diamante" : points >= 1500 ? "Ouro" : points >= 500 ? "Prata" : "Cliente",
    nextLevel: points >= 5000 ? "Elite" : "Diamante",
    nextGoal,
    progress,
    missingPoints: Math.max(0, nextGoal - points),
    lastPurchaseAt: paidOrders[0]?.paidAt || paidOrders[0]?.createdAt || null,
  };
}


router.get("/oauth/:provider", async (req, res) => {
  try {
    const provider = cleanText(req.params.provider).toLowerCase();

    if (!OAUTH_PROVIDER_LABELS[provider]) {
      return redirectToLoginWithOAuthError(res, "Provedor de login social inválido.", {
        loginUrl: req.query?.login_url,
      });
    }

    const credentials = getProviderCredentials(provider);

    if (!credentials.clientId || !credentials.clientSecret) {
      return redirectToLoginWithOAuthError(
        res,
        `Login com ${OAUTH_PROVIDER_LABELS[provider]} ainda não está configurado na API.`,
        { loginUrl: req.query?.login_url }
      );
    }

    const redirectUri = getOAuthRedirectUri(req, provider);
    const state = createOAuthState(provider, req);
    const authorizeUrl = buildOAuthAuthorizeUrl(provider, credentials, redirectUri, state);

    return res.redirect(302, authorizeUrl.toString());
  } catch (error) {
    console.error("ERRO AO INICIAR LOGIN SOCIAL:", error);
    return redirectToLoginWithOAuthError(res, "Não foi possível iniciar o login social.", {
      loginUrl: req.query?.login_url,
    });
  }
});

router.get("/oauth/:provider/callback", async (req, res) => {
  let stateData = null;

  try {
    const provider = cleanText(req.params.provider).toLowerCase();

    if (!OAUTH_PROVIDER_LABELS[provider]) {
      return redirectToLoginWithOAuthError(res, "Provedor de login social inválido.");
    }

    stateData = verifyOAuthState(req.query?.state);

    if (stateData.provider !== provider) {
      return redirectToLoginWithOAuthError(res, "Sessão do login social inválida.", stateData);
    }

    if (req.query?.error) {
      return redirectToLoginWithOAuthError(
        res,
        "Login social cancelado ou não autorizado.",
        stateData
      );
    }

    const code = cleanText(req.query?.code);

    if (!code) {
      return redirectToLoginWithOAuthError(res, "Código de login social ausente.", stateData);
    }

    const credentials = getProviderCredentials(provider);

    if (!credentials.clientId || !credentials.clientSecret) {
      return redirectToLoginWithOAuthError(
        res,
        `Login com ${OAUTH_PROVIDER_LABELS[provider]} ainda não está configurado na API.`,
        stateData
      );
    }

    const redirectUri = getOAuthRedirectUri(req, provider);
    const profile = provider === "google"
      ? await exchangeGoogleCodeForProfile(code, credentials, redirectUri)
      : await exchangeFacebookCodeForProfile(code, credentials, redirectUri);

    const customer = await getOrCreateCustomerFromSocialProfile(profile);
    const authResponse = buildAuthResponse(
      {
        ...customer,
        last_login_at: new Date().toISOString(),
        account_enabled: true,
      },
      `Login com ${OAUTH_PROVIDER_LABELS[provider]} realizado com sucesso.`
    );

    return redirectToLoginWithOAuthSuccess(res, stateData, authResponse, provider);
  } catch (error) {
    console.error("ERRO NO CALLBACK DO LOGIN SOCIAL:", error);
    return redirectToLoginWithOAuthError(
      res,
      error.message || "Não foi possível concluir o login social.",
      stateData || {}
    );
  }
});

router.post("/register", async (req, res) => {
  try {
    const data = getRequestData(req);
    const validationError = validateRegisterInput(data);

    if (validationError) {
      return res.status(400).json({
        success: false,
        message: validationError,
      });
    }

    const existingCustomer = await findCustomerByEmail(data.email);

    if (existingCustomer?.id) {
      return res.status(409).json({
        success: false,
        message: existingCustomer.password_hash
          ? "Já existe uma conta com este e-mail. Faça login para continuar."
          : "Este e-mail já foi usado em uma compra. Entre com Google/Facebook ou solicite a ativação segura da conta.",
        code: existingCustomer.password_hash
          ? "CUSTOMER_ACCOUNT_EXISTS"
          : "CUSTOMER_EMAIL_REQUIRES_VERIFICATION",
      });
    }

    const passwordHash = await bcrypt.hash(data.password, 12);
    const customer = await createCustomerAccount(data, passwordHash);

    return res.status(201).json(
      buildAuthResponse(customer, "Conta criada com sucesso.")
    );
  } catch (error) {
    console.error("ERRO AO CADASTRAR CLIENTE:", error);

    return res.status(500).json({
      success: false,
      message:
        "Erro ao criar conta. Confira se a atualização SQL de contas de cliente foi aplicada no Supabase.",
    });
  }
});

router.post("/login", async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || req.body?.senha || "");
    const validationError = validateLoginInput(email, password);

    if (validationError) {
      return res.status(400).json({
        success: false,
        message: validationError,
      });
    }

    const customer = await findCustomerByEmail(email);

    if (!customer?.id || !customer.password_hash) {
      return res.status(401).json({
        success: false,
        message: "E-mail ou senha inválidos.",
      });
    }

    if (customer.account_enabled !== true) {
      return res.status(403).json({
        success: false,
        message: "Esta conta está desativada. Fale com o suporte para reativar o acesso.",
      });
    }

    const passwordMatches = await bcrypt.compare(password, customer.password_hash);

    if (!passwordMatches) {
      return res.status(401).json({
        success: false,
        message: "E-mail ou senha inválidos.",
      });
    }

    await touchLastLogin(customer.id);

    return res.status(200).json(
      buildAuthResponse(
        {
          ...customer,
          last_login_at: new Date().toISOString(),
          account_enabled: true,
        },
        "Login realizado com sucesso."
      )
    );
  } catch (error) {
    console.error("ERRO NO LOGIN DO CLIENTE:", error);

    return res.status(500).json({
      success: false,
      message: "Erro ao realizar login do cliente.",
    });
  }
});

router.get("/me", requireCustomerAuth, async (req, res) => {
  try {
    const customer = req.customer;
    const orders = await fetchCustomerOrders(customer);

    return res.status(200).json({
      success: true,
      customer: mapCustomer(customer),
      orders,
      summary: buildAccountSummary(customer, orders),
    });
  } catch (error) {
    console.error("ERRO AO BUSCAR CONTA DO CLIENTE:", error);

    return res.status(500).json({
      success: false,
      message: "Erro ao carregar conta do cliente.",
    });
  }
});

export default router;
