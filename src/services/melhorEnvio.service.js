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
    Accept: "application/json"
  };
}

export function getMelhorEnvioConfig() {
  return {
    clientId: getRequiredEnv(
      "MELHOR_ENVIO_CLIENT_ID",
      process.env.MELHOR_ENVIO_CLIENT_ID
    ),
    clientSecret: getRequiredEnv(
      "MELHOR_ENVIO_CLIENT_SECRET",
      process.env.MELHOR_ENVIO_CLIENT_SECRET
    ),
    redirectUri: getRequiredEnv(
      "MELHOR_ENVIO_REDIRECT_URI",
      process.env.MELHOR_ENVIO_REDIRECT_URI
    ),
    baseUrl: String(
      process.env.MELHOR_ENVIO_BASE_URL || "https://melhorenvio.com.br/api/v2"
    ).trim(),
    shippingProvider: String(process.env.SHIPPING_PROVIDER || "").trim()
  };
}

export function getMelhorEnvioUserAgent() {
  return String(
    process.env.MELHOR_ENVIO_USER_AGENT || "OZONTECK (ozonteck14@gmail.com)"
  ).trim();
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
    scope:
      "shipping-calculate shipping-checkout shipping-generate shipping-tracking"
  });

  return `${authBase}?${params.toString()}`;
}

export async function exchangeMelhorEnvioCodeForToken(code) {
  const { clientId, clientSecret, redirectUri, baseUrl } =
    getMelhorEnvioConfig();

  const tokenUrl = baseUrl.includes("sandbox")
    ? "https://sandbox.melhorenvio.com.br/oauth/token"
    : "https://melhorenvio.com.br/oauth/token";

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    code: String(code || "").trim()
  });

  console.log(
  "MELHOR ENVIO TOKEN EXCHANGE: " +
    JSON.stringify({
      tokenUrl,
      clientId,
      redirectUri,
      hasClientSecret: Boolean(clientSecret),
      codePreview: String(code || "").slice(0, 10)
    })
);

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: body.toString()
  });

  const data = await response.json().catch(() => null);

  if (!response.ok || !data?.access_token) {
    console.error(
  "MELHOR ENVIO TOKEN EXCHANGE ERROR: " +
    JSON.stringify({
      status: response.status,
      data
    })
);
  }

  return data;
}

export async function saveMelhorEnvioTokens(tokenData) {
  const expiresIn = Number(tokenData?.expires_in || 0);
  const expiresAt = expiresIn
    ? new Date(Date.now() + expiresIn * 1000).toISOString()
    : null;

  const payload = [
    {
      provider: "melhor_envio",
      access_token: String(tokenData.access_token || "").trim(),
      refresh_token: String(tokenData.refresh_token || "").trim(),
      expires_at: expiresAt,
      updated_at: new Date().toISOString()
    }
  ];

  const url = new URL(`${env.supabaseUrl}/rest/v1/shipping_integrations`);
  url.searchParams.set("on_conflict", "provider");

  const response = await fetch(url.toString(), {
    method: "POST",
    headers: {
      ...getSupabaseHeaders(),
      Prefer: "resolution=merge-duplicates,return=representation"
    },
    body: JSON.stringify(payload)
  });

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(
      data?.message || data?.error || "Erro ao salvar token do Melhor Envio"
    );
  }

  return Array.isArray(data) ? data[0] : data;
}

export async function getMelhorEnvioAccessToken() {
  const record = await getMelhorEnvioTokenRecord();
  const accessToken = String(record?.access_token || "").trim();

  console.log(
    "MELHOR ENVIO ACCESS TOKEN CHECK: " +
      JSON.stringify({
        hasRecord: Boolean(record),
        provider: record?.provider || null,
        hasAccessToken: Boolean(accessToken),
        expiresAt: record?.expires_at || null
      })
  );

  if (!accessToken) {
    throw new Error("Melhor Envio não está conectado");
  }

  return accessToken;
}

export async function getMelhorEnvioAccessToken() {
  const record = await getMelhorEnvioTokenRecord();
  const accessToken = String(record?.access_token || "").trim();

  if (!accessToken) {
    throw new Error("Melhor Envio não está conectado");
  }

  return accessToken;
}

export function buildMelhorEnvioHeaders(accessToken) {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    Authorization: `Bearer ${accessToken}`,
    "User-Agent": getMelhorEnvioUserAgent()
  };
}

export async function calculateShippingWithMelhorEnvio(payload) {
  const accessToken = await getMelhorEnvioAccessToken();
  const { baseUrl } = getMelhorEnvioConfig();

  const response = await fetch(`${baseUrl}/me/shipment/calculate`, {
    method: "POST",
    headers: buildMelhorEnvioHeaders(accessToken),
    body: JSON.stringify(payload)
  });

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(
      data?.message ||
        data?.error ||
        "Erro ao calcular frete no Melhor Envio"
    );
  }

  return Array.isArray(data) ? data : [];
}