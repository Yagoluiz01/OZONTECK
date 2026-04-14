import { env } from "../config/env.js";

function getRequiredEnv(name, value) {
  const normalized = String(value || "").trim();

  if (!normalized) {
    throw new Error(`Variável obrigatória ausente: ${name}`);
  }

  return normalized;
}

function getSupabaseHeaders() {
  return {
    apikey: env.supabaseServiceRoleKey,
    Authorization: `Bearer ${env.supabaseServiceRoleKey}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

export function getMelhorEnvioConfig() {
  return {
    clientId: getRequiredEnv("MELHOR_ENVIO_CLIENT_ID", process.env.MELHOR_ENVIO_CLIENT_ID),
    clientSecret: getRequiredEnv("MELHOR_ENVIO_CLIENT_SECRET", process.env.MELHOR_ENVIO_CLIENT_SECRET),
    redirectUri: getRequiredEnv("MELHOR_ENVIO_REDIRECT_URI", process.env.MELHOR_ENVIO_REDIRECT_URI),
    baseUrl: String(process.env.MELHOR_ENVIO_BASE_URL || "https://sandbox.melhorenvio.com.br/api/v2").trim(),
    shippingProvider: String(process.env.SHIPPING_PROVIDER || "").trim(),
  };
}

export function buildMelhorEnvioAuthorizeUrl() {
  const { clientId, redirectUri, baseUrl } = getMelhorEnvioConfig();
  const authBase = baseUrl.includes("sandbox")
    ? "https://sandbox.melhorenvio.com.br/oauth/authorize"
    : "https://melhorenvio.com.br/oauth/authorize";

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "shipping-calculate shipping-cart shipping-generate shipping-tracking",
  });

  return `${authBase}?${params.toString()}`;
}

export async function exchangeMelhorEnvioCodeForToken(code) {
  const { clientId, clientSecret, redirectUri, baseUrl } = getMelhorEnvioConfig();
  const tokenUrl = baseUrl.includes("sandbox")
    ? "https://sandbox.melhorenvio.com.br/oauth/token"
    : "https://melhorenvio.com.br/oauth/token";

  const body = {
    grant_type: "authorization_code",
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    code,
  };

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = await response.json().catch(() => null);

  if (!response.ok || !data?.access_token) {
    throw new Error(
      data?.message ||
        data?.error_description ||
        data?.error ||
        "Erro ao trocar code por token no Melhor Envio"
    );
  }

  return data;
}

export async function saveMelhorEnvioTokens(tokenData) {
  const expiresIn = Number(tokenData?.expires_in || 0);
  const expiresAt = expiresIn
    ? new Date(Date.now() + expiresIn * 1000).toISOString()
    : null;

  const payload = {
    provider: "melhor_envio",
    access_token: String(tokenData.access_token || "").trim(),
    refresh_token: String(tokenData.refresh_token || "").trim(),
    expires_at: expiresAt,
    updated_at: new Date().toISOString(),
  };

  const response = await fetch(`${env.supabaseUrl}/rest/v1/shipping_integrations`, {
    method: "POST",
    headers: {
      ...getSupabaseHeaders(),
      Prefer: "resolution=merge-duplicates,return=representation",
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(
      data?.message || data?.error || "Erro ao salvar token do Melhor Envio"
    );
  }

  return Array.isArray(data) ? data[0] : data;
}

export async function getMelhorEnvioTokenRecord() {
  const url = new URL(`${env.supabaseUrl}/rest/v1/shipping_integrations`);
  url.searchParams.set("provider", "eq.melhor_envio");
  url.searchParams.set("select", "*");
  url.searchParams.set("limit", "1");

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: getSupabaseHeaders(),
  });

  const data = await response.json().catch(() => []);

  if (!response.ok) {
    throw new Error("Erro ao consultar token do Melhor Envio");
  }

  return Array.isArray(data) ? data[0] || null : null;
}