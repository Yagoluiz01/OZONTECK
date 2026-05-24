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

  const scopes = [
    "cart-read",
    "cart-write",
    "shipping-calculate",
    "shipping-checkout",
    "shipping-generate",
    "shipping-tracking",
    "shipping-print"
  ];

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: scopes.join(" ")
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
          message: data?.message || data?.error_description || data?.error || null,
          hasAccessToken: Boolean(data?.access_token),
          hasRefreshToken: Boolean(data?.refresh_token)
        })
    );

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
  console.log(
    "MELHOR ENVIO TOKEN RAW: " +
      JSON.stringify({
        keys: tokenData ? Object.keys(tokenData) : [],
        hasAccessToken: Boolean(
          tokenData?.access_token || tokenData?.token || tokenData?.accessToken
        ),
        hasRefreshToken: Boolean(
          tokenData?.refresh_token || tokenData?.refreshToken
        ),
        expiresIn: tokenData?.expires_in || tokenData?.expiresIn || null
      })
  );

  const accessToken = String(
    tokenData?.access_token || tokenData?.token || tokenData?.accessToken || ""
  ).trim();

  const refreshToken = String(
    tokenData?.refresh_token || tokenData?.refreshToken || ""
  ).trim();

  const expiresIn = Number(tokenData?.expires_in || tokenData?.expiresIn || 0);

  const expiresAt = expiresIn
    ? new Date(Date.now() + expiresIn * 1000).toISOString()
    : null;

  if (!accessToken) {
    throw new Error("Token do Melhor Envio veio vazio ao salvar integração");
  }

  const payload = [
    {
      provider: "melhor_envio",
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_at: expiresAt,
      updated_at: new Date().toISOString()
    }
  ];

  console.log(
    "MELHOR ENVIO TOKEN SAVE PAYLOAD: " +
      JSON.stringify({
        provider: payload[0].provider,
        hasAccessToken: Boolean(payload[0].access_token),
        hasRefreshToken: Boolean(payload[0].refresh_token),
        expiresAt: payload[0].expires_at
      })
  );

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

  console.log(
    "MELHOR ENVIO TOKEN SAVE RESULT: " +
      JSON.stringify({
        status: response.status,
        saved: response.ok,
        provider: Array.isArray(data) && data[0] ? data[0].provider : null,
        hasAccessToken:
          Array.isArray(data) && data[0]
            ? Boolean(String(data[0].access_token || "").trim())
            : false,
        hasRefreshToken:
          Array.isArray(data) && data[0]
            ? Boolean(String(data[0].refresh_token || "").trim())
            : false,
        expiresAt: Array.isArray(data) && data[0] ? data[0].expires_at : null
      })
  );

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

  console.log(
    "MELHOR ENVIO TOKEN QUERY: " +
      JSON.stringify({
        url: url.toString(),
        hasSupabaseUrl: Boolean(env.supabaseUrl),
        hasServiceRoleKey: Boolean(env.supabaseServiceRoleKey)
      })
  );

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: getSupabaseHeaders()
  });

  const data = await response.json().catch(() => []);

  console.log(
    "MELHOR ENVIO TOKEN QUERY RESULT: " +
      JSON.stringify({
        status: response.status,
        found: Array.isArray(data) ? data.length : 0,
        firstProvider: Array.isArray(data) && data[0] ? data[0].provider : null,
        hasAccessToken:
          Array.isArray(data) && data[0]
            ? Boolean(String(data[0].access_token || "").trim())
            : false,
        hasRefreshToken:
          Array.isArray(data) && data[0]
            ? Boolean(String(data[0].refresh_token || "").trim())
            : false,
        expiresAt: Array.isArray(data) && data[0] ? data[0].expires_at : null
      })
  );

  if (!response.ok) {
    throw new Error("Erro ao consultar token do Melhor Envio");
  }

  return Array.isArray(data) ? data[0] || null : null;
}

function getMelhorEnvioTokenUrl(baseUrl) {
  return baseUrl.includes("sandbox")
    ? "https://sandbox.melhorenvio.com.br/oauth/token"
    : "https://melhorenvio.com.br/oauth/token";
}

function isMelhorEnvioTokenExpired(expiresAt) {
  if (!expiresAt) return false;

  const expiresTime = new Date(expiresAt).getTime();

  if (!Number.isFinite(expiresTime)) {
    return true;
  }

  const safetyWindowMs = 60 * 1000;

  return expiresTime <= Date.now() + safetyWindowMs;
}

export async function refreshMelhorEnvioAccessToken(record) {
  const refreshToken = String(record?.refresh_token || "").trim();

  if (!refreshToken) {
    throw new Error("Melhor Envio precisa ser reconectado");
  }

  const { clientId, clientSecret, baseUrl } = getMelhorEnvioConfig();
  const tokenUrl = getMelhorEnvioTokenUrl(baseUrl);

  console.log(
    "MELHOR ENVIO REFRESH TOKEN: " +
      JSON.stringify({
        tokenUrl,
        provider: record?.provider || null,
        hasRefreshToken: Boolean(refreshToken),
        expiresAt: record?.expires_at || null
      })
  );

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken
  });

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
      "MELHOR ENVIO REFRESH TOKEN ERROR: " +
        JSON.stringify({
          status: response.status,
          message: data?.message || data?.error_description || data?.error || null,
          hasAccessToken: Boolean(data?.access_token),
          hasRefreshToken: Boolean(data?.refresh_token)
        })
    );

    throw new Error(
      data?.message ||
        data?.error_description ||
        data?.error ||
        "Erro ao renovar token do Melhor Envio"
    );
  }

  const saved = await saveMelhorEnvioTokens({
    ...data,
    refresh_token: data?.refresh_token || refreshToken
  });

  console.log(
    "MELHOR ENVIO REFRESH TOKEN OK: " +
      JSON.stringify({
        provider: saved?.provider || null,
        hasAccessToken: Boolean(String(saved?.access_token || "").trim()),
        hasRefreshToken: Boolean(String(saved?.refresh_token || "").trim()),
        expiresAt: saved?.expires_at || null
      })
  );

  return String(saved?.access_token || data.access_token || "").trim();
}

export async function getMelhorEnvioAccessToken() {
  const record = await getMelhorEnvioTokenRecord();
  const accessToken = String(record?.access_token || "").trim();
  const tokenExpired = isMelhorEnvioTokenExpired(record?.expires_at);

  console.log(
    "MELHOR ENVIO ACCESS TOKEN CHECK: " +
      JSON.stringify({
        hasRecord: Boolean(record),
        provider: record?.provider || null,
        hasAccessToken: Boolean(accessToken),
        hasRefreshToken: Boolean(String(record?.refresh_token || "").trim()),
        expiresAt: record?.expires_at || null,
        tokenExpired
      })
  );

  if (!accessToken) {
    throw new Error("Melhor Envio nÃ£o estÃ¡ conectado");
  }

  if (tokenExpired) {
    return refreshMelhorEnvioAccessToken(record);
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

function isMelhorEnvioUnauthenticated(response, data) {
  const message = String(
    data?.message || data?.error_description || data?.error || ""
  ).toLowerCase();

  return response.status === 401 || message.includes("unauthenticated");
}

async function requestMelhorEnvioShippingQuote(baseUrl, accessToken, payload) {
  const response = await fetch(`${baseUrl}/me/shipment/calculate`, {
    method: "POST",
    headers: buildMelhorEnvioHeaders(accessToken),
    body: JSON.stringify(payload)
  });

  const data = await response.json().catch(() => null);

  return { response, data };
}

export async function calculateShippingWithMelhorEnvio(payload) {
  const { baseUrl } = getMelhorEnvioConfig();

  let accessToken = await getMelhorEnvioAccessToken();

  let { response, data } = await requestMelhorEnvioShippingQuote(
    baseUrl,
    accessToken,
    payload
  );

  if (!response.ok && isMelhorEnvioUnauthenticated(response, data)) {
    console.warn(
      "MELHOR ENVIO QUOTE UNAUTHENTICATED: tentando renovar token e repetir cotacao"
    );

    const record = await getMelhorEnvioTokenRecord();
    accessToken = await refreshMelhorEnvioAccessToken(record);

    const retry = await requestMelhorEnvioShippingQuote(
      baseUrl,
      accessToken,
      payload
    );

    response = retry.response;
    data = retry.data;
  }

  if (!response.ok) {
    throw new Error(
      data?.message ||
        data?.error_description ||
        data?.error ||
        "Erro ao calcular frete no Melhor Envio"
    );
  }

  return Array.isArray(data) ? data : [];
}