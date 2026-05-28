import { env } from "../config/env.js";

const SETTINGS_TABLE = "store_theme_settings";
const PALETTES_TABLE = "store_color_palettes";
const SETTINGS_ID = "main";

export const DEFAULT_THEME_COLORS = {
  primaryColor: "#11d1b2",
  secondaryColor: "#071014",
  accentColor: "#d6ff59",
  backgroundColor: "#071014",
  textColor: "#eaf4f7",
  buttonColor: "#d6ff59",
  cardColor: "#0d1a20",
  priceColor: "#d6ff59",
  headerColor: "#050a0c",
  footerColor: "#04080a",
};

export const PRESET_PALETTES = [
  {
    id: "ozonteck_default",
    type: "preset",
    name: "OZONTECK Padrão",
    description: "Visual atual da loja, com verde-limão e azul petróleo.",
    colors: {
      primaryColor: "#11d1b2",
      secondaryColor: "#071014",
      accentColor: "#d6ff59",
      backgroundColor: "#071014",
      textColor: "#eaf4f7",
      buttonColor: "#d6ff59",
      cardColor: "#0d1a20",
      priceColor: "#d6ff59",
      headerColor: "#050a0c",
      footerColor: "#04080a",
    },
  },
  {
    id: "premium_dark",
    type: "preset",
    name: "Premium Escuro",
    description: "Preto, dourado e branco para uma percepção mais sofisticada.",
    colors: {
      primaryColor: "#d4af37",
      secondaryColor: "#050505",
      accentColor: "#f8d66d",
      backgroundColor: "#080808",
      textColor: "#fffaf0",
      buttonColor: "#d4af37",
      cardColor: "#15110a",
      priceColor: "#f8d66d",
      headerColor: "#050505",
      footerColor: "#050505",
    },
  },
  {
    id: "clean_saude",
    type: "preset",
    name: "Clean Saúde",
    description: "Branco, azul e verde para uma sensação leve e confiável.",
    colors: {
      primaryColor: "#0284c7",
      secondaryColor: "#e0f2fe",
      accentColor: "#22c55e",
      backgroundColor: "#f8fafc",
      textColor: "#0f172a",
      buttonColor: "#0284c7",
      cardColor: "#ffffff",
      priceColor: "#16a34a",
      headerColor: "#ffffff",
      footerColor: "#e0f2fe",
    },
  },
  {
    id: "alta_conversao",
    type: "preset",
    name: "Alta Conversão",
    description: "Azul escuro e laranja para destacar ofertas e botões de compra.",
    colors: {
      primaryColor: "#1d4ed8",
      secondaryColor: "#0f172a",
      accentColor: "#f97316",
      backgroundColor: "#0b1220",
      textColor: "#f8fafc",
      buttonColor: "#f97316",
      cardColor: "#111827",
      priceColor: "#fb923c",
      headerColor: "#0f172a",
      footerColor: "#020617",
    },
  },
  {
    id: "natureza_ozonio",
    type: "preset",
    name: "Natureza / Ozônio",
    description: "Verde, azul e branco para reforçar frescor, limpeza e bem-estar.",
    colors: {
      primaryColor: "#0f766e",
      secondaryColor: "#ecfeff",
      accentColor: "#84cc16",
      backgroundColor: "#f0fdfa",
      textColor: "#134e4a",
      buttonColor: "#0f766e",
      cardColor: "#ffffff",
      priceColor: "#65a30d",
      headerColor: "#ecfeff",
      footerColor: "#ccfbf1",
    },
  },
  {
    id: "minimalista",
    type: "preset",
    name: "Minimalista",
    description: "Base clara e neutra para uma loja limpa e moderna.",
    colors: {
      primaryColor: "#2563eb",
      secondaryColor: "#f1f5f9",
      accentColor: "#0f172a",
      backgroundColor: "#ffffff",
      textColor: "#111827",
      buttonColor: "#2563eb",
      cardColor: "#f8fafc",
      priceColor: "#2563eb",
      headerColor: "#ffffff",
      footerColor: "#f1f5f9",
    },
  },
];

function supabaseHeaders({ prefer = false } = {}) {
  const headers = {
    apikey: env.supabaseServiceRoleKey,
    Authorization: `Bearer ${env.supabaseServiceRoleKey}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  if (prefer) {
    headers.Prefer = "return=representation,resolution=merge-duplicates";
  }

  return headers;
}

function normalizeText(value) {
  return String(value || "").trim();
}

function safeColor(value, fallback) {
  const color = normalizeText(value);
  return color || fallback;
}

function normalizeColors(value = {}) {
  return {
    primaryColor: safeColor(value.primaryColor || value.primary_color, DEFAULT_THEME_COLORS.primaryColor),
    secondaryColor: safeColor(value.secondaryColor || value.secondary_color, DEFAULT_THEME_COLORS.secondaryColor),
    accentColor: safeColor(value.accentColor || value.accent_color, DEFAULT_THEME_COLORS.accentColor),
    backgroundColor: safeColor(value.backgroundColor || value.background_color, DEFAULT_THEME_COLORS.backgroundColor),
    textColor: safeColor(value.textColor || value.text_color, DEFAULT_THEME_COLORS.textColor),
    buttonColor: safeColor(value.buttonColor || value.button_color, DEFAULT_THEME_COLORS.buttonColor),
    cardColor: safeColor(value.cardColor || value.card_color, DEFAULT_THEME_COLORS.cardColor),
    priceColor: safeColor(value.priceColor || value.price_color, DEFAULT_THEME_COLORS.priceColor),
    headerColor: safeColor(value.headerColor || value.header_color, DEFAULT_THEME_COLORS.headerColor),
    footerColor: safeColor(value.footerColor || value.footer_color, DEFAULT_THEME_COLORS.footerColor),
  };
}

function rowToPalette(row = {}) {
  return {
    id: row.id,
    type: row.type || "custom",
    name: row.name || "Paleta personalizada",
    description: row.description || "Paleta criada no admin.",
    colors: normalizeColors(row),
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

function settingRowToTheme(row = {}) {
  const colors = normalizeColors(row.colors || row);

  return {
    id: row.id || SETTINGS_ID,
    brandName: row.brand_name || "OZONTECK",
    brandSlogan: row.brand_slogan || "Tecnologia em ozônio para sua rotina",
    logoUrl: row.logo_url || "",
    faviconUrl: row.favicon_url || "",
    activePaletteId: row.active_palette_id || "ozonteck_default",
    activePaletteType: row.active_palette_type || "preset",
    colors,
    updatedAt: row.updated_at || null,
  };
}

function defaultTheme() {
  return {
    id: SETTINGS_ID,
    brandName: "OZONTECK",
    brandSlogan: "Tecnologia em ozônio para sua rotina",
    logoUrl: "",
    faviconUrl: "",
    activePaletteId: "ozonteck_default",
    activePaletteType: "preset",
    colors: { ...DEFAULT_THEME_COLORS },
    updatedAt: null,
  };
}

function isMissingTableError(payload) {
  const message = JSON.stringify(payload || {}).toLowerCase();
  return (
    message.includes("could not find the table") ||
    message.includes("relation") && message.includes("does not exist") ||
    message.includes("schema cache")
  );
}

async function requestSupabase(path, options = {}) {
  const response = await fetch(`${env.supabaseUrl}/rest/v1/${path}`, options);
  const data = await response.json().catch(() => null);

  if (!response.ok) {
    const error = new Error(data?.message || data?.error || "Erro ao consultar Supabase");
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return data;
}

async function fetchSettingsRow() {
  const params = new URLSearchParams({
    id: `eq.${SETTINGS_ID}`,
    select: "*",
    limit: "1",
  });

  const rows = await requestSupabase(`${SETTINGS_TABLE}?${params.toString()}`, {
    method: "GET",
    headers: supabaseHeaders(),
  });

  return Array.isArray(rows) ? rows[0] || null : null;
}

async function fetchCustomPaletteRows() {
  const params = new URLSearchParams({
    select: "*",
    order: "created_at.desc",
  });

  const rows = await requestSupabase(`${PALETTES_TABLE}?${params.toString()}`, {
    method: "GET",
    headers: supabaseHeaders(),
  });

  return Array.isArray(rows) ? rows : [];
}

function setupRequiredPayload(error) {
  return {
    theme: defaultTheme(),
    presetPalettes: PRESET_PALETTES,
    customPalettes: [],
    setupRequired: true,
    setupMessage:
      "Rode o SQL api/sql/store-theme-settings.sql no Supabase para ativar tema e paletas personalizadas.",
    error: error?.data || error?.message || null,
  };
}

export async function getStoreThemeBundle() {
  try {
    const [settingsRow, customRows] = await Promise.all([
      fetchSettingsRow(),
      fetchCustomPaletteRows(),
    ]);

    return {
      theme: settingRowToTheme(settingsRow || defaultTheme()),
      presetPalettes: PRESET_PALETTES,
      customPalettes: customRows.map(rowToPalette),
      setupRequired: false,
      setupMessage: "",
    };
  } catch (error) {
    if (isMissingTableError(error.data || error.message)) {
      return setupRequiredPayload(error);
    }

    throw error;
  }
}

export async function getPublicStoreTheme() {
  const bundle = await getStoreThemeBundle();

  return {
    theme: bundle.theme,
    setupRequired: bundle.setupRequired,
    setupMessage: bundle.setupMessage,
  };
}

export async function saveStoreTheme(payload = {}) {
  const colors = normalizeColors(payload.colors || payload);

  const row = {
    id: SETTINGS_ID,
    brand_name: normalizeText(payload.brandName || payload.brand_name) || "OZONTECK",
    brand_slogan: normalizeText(payload.brandSlogan || payload.brand_slogan),
    logo_url: normalizeText(payload.logoUrl || payload.logo_url),
    favicon_url: normalizeText(payload.faviconUrl || payload.favicon_url),
    active_palette_id: normalizeText(payload.activePaletteId || payload.active_palette_id) || "custom_current",
    active_palette_type: normalizeText(payload.activePaletteType || payload.active_palette_type) || "custom",
    primary_color: colors.primaryColor,
    secondary_color: colors.secondaryColor,
    accent_color: colors.accentColor,
    background_color: colors.backgroundColor,
    text_color: colors.textColor,
    button_color: colors.buttonColor,
    card_color: colors.cardColor,
    price_color: colors.priceColor,
    header_color: colors.headerColor,
    footer_color: colors.footerColor,
    colors,
    updated_at: new Date().toISOString(),
  };

  const rows = await requestSupabase(`${SETTINGS_TABLE}?on_conflict=id`, {
    method: "POST",
    headers: supabaseHeaders({ prefer: true }),
    body: JSON.stringify(row),
  });

  const saved = Array.isArray(rows) ? rows[0] : rows;
  return settingRowToTheme(saved || row);
}

export async function createCustomPalette(payload = {}) {
  const colors = normalizeColors(payload.colors || payload);
  const name = normalizeText(payload.name);

  if (!name) {
    throw new Error("Informe um nome para a paleta.");
  }

  const row = {
    name,
    type: "custom",
    description: normalizeText(payload.description) || "Paleta criada no admin.",
    primary_color: colors.primaryColor,
    secondary_color: colors.secondaryColor,
    accent_color: colors.accentColor,
    background_color: colors.backgroundColor,
    text_color: colors.textColor,
    button_color: colors.buttonColor,
    card_color: colors.cardColor,
    price_color: colors.priceColor,
    header_color: colors.headerColor,
    footer_color: colors.footerColor,
  };

  const rows = await requestSupabase(PALETTES_TABLE, {
    method: "POST",
    headers: supabaseHeaders({ prefer: true }),
    body: JSON.stringify(row),
  });

  return rowToPalette(Array.isArray(rows) ? rows[0] : rows);
}

export async function updateCustomPalette(id, payload = {}) {
  const paletteId = normalizeText(id);

  if (!paletteId) {
    throw new Error("ID da paleta é obrigatório.");
  }

  const colors = normalizeColors(payload.colors || payload);
  const row = {
    name: normalizeText(payload.name) || "Paleta personalizada",
    description: normalizeText(payload.description) || "Paleta criada no admin.",
    primary_color: colors.primaryColor,
    secondary_color: colors.secondaryColor,
    accent_color: colors.accentColor,
    background_color: colors.backgroundColor,
    text_color: colors.textColor,
    button_color: colors.buttonColor,
    card_color: colors.cardColor,
    price_color: colors.priceColor,
    header_color: colors.headerColor,
    footer_color: colors.footerColor,
    updated_at: new Date().toISOString(),
  };

  const rows = await requestSupabase(`${PALETTES_TABLE}?id=eq.${encodeURIComponent(paletteId)}`, {
    method: "PATCH",
    headers: supabaseHeaders({ prefer: true }),
    body: JSON.stringify(row),
  });

  return rowToPalette(Array.isArray(rows) ? rows[0] : rows);
}

export async function deleteCustomPalette(id) {
  const paletteId = normalizeText(id);

  if (!paletteId) {
    throw new Error("ID da paleta é obrigatório.");
  }

  await requestSupabase(`${PALETTES_TABLE}?id=eq.${encodeURIComponent(paletteId)}`, {
    method: "DELETE",
    headers: supabaseHeaders(),
  });

  return true;
}
