import express from "express";
import { env } from "../config/env.js";
import { requireAdminAuth } from "../middlewares/auth.middleware.js";

const router = express.Router();

const ALLOWED_PROVIDERS = new Set([
  "meta",
  "tiktok",
  "google_ads",
  "google_analytics",
  "kwai",
  "pinterest",
  "custom",
]);

const DEFAULT_EVENTS = ["PageView"];

function getSupabaseHeaders() {
  return {
    apikey: env.supabaseServiceRoleKey,
    Authorization: `Bearer ${env.supabaseServiceRoleKey}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

function safeString(value) {
  return String(value || "").trim();
}

function safeArray(value, fallback = []) {
  return Array.isArray(value) ? value : fallback;
}

function normalizeProvider(value) {
  return safeString(value).toLowerCase();
}

function normalizePixelPayload(body = {}) {
  const provider = normalizeProvider(body.provider);
  const name = safeString(body.name);
  const pixelId = safeString(body.pixelId || body.pixel_id);
  const isActive =
    typeof body.isActive === "boolean"
      ? body.isActive
      : typeof body.is_active === "boolean"
        ? body.is_active
        : true;

  const enabledEvents = safeArray(
    body.enabledEvents || body.enabled_events,
    DEFAULT_EVENTS
  )
    .map(safeString)
    .filter(Boolean);

  const pageRules = safeArray(body.pageRules || body.page_rules, ["all"])
    .map(safeString)
    .filter(Boolean);

  const extraConfig =
    body.extraConfig && typeof body.extraConfig === "object"
      ? body.extraConfig
      : body.extra_config && typeof body.extra_config === "object"
        ? body.extra_config
        : {};

  return {
    provider,
    name,
    pixelId,
    isActive,
    enabledEvents: enabledEvents.length ? enabledEvents : DEFAULT_EVENTS,
    pageRules: pageRules.length ? pageRules : ["all"],
    extraConfig,
  };
}

function validatePixelPayload(payload) {
  if (!ALLOWED_PROVIDERS.has(payload.provider)) {
    return "Plataforma de pixel inválida";
  }

  if (!payload.name) {
    return "Informe um nome para o pixel";
  }

  if (!payload.pixelId) {
    return "Informe o ID do pixel";
  }

  return "";
}

function normalizePixel(row = {}) {
  return {
    id: row.id,
    provider: safeString(row.provider),
    name: safeString(row.name),
    pixelId: safeString(row.pixel_id),
    isActive: Boolean(row.is_active),
    enabledEvents: safeArray(row.enabled_events),
    pageRules: safeArray(row.page_rules, ["all"]),
    extraConfig:
      row.extra_config && typeof row.extra_config === "object"
        ? row.extra_config
        : {},
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

router.get("/", requireAdminAuth, async (req, res) => {
  try {
    const url = new URL(`${env.supabaseUrl}/rest/v1/marketing_pixels`);

    url.searchParams.set(
      "select",
      "id,provider,name,pixel_id,is_active,enabled_events,page_rules,extra_config,created_at,updated_at"
    );
    url.searchParams.set("order", "created_at.desc");

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: getSupabaseHeaders(),
    });

    const data = await response.json().catch(() => []);

    if (!response.ok) {
      return res.status(500).json({
        success: false,
        message: data?.message || data?.error || "Erro ao buscar pixels",
      });
    }

    return res.json({
      success: true,
      pixels: Array.isArray(data) ? data.map(normalizePixel) : [],
    });
  } catch (error) {
    console.error("ERRO AO LISTAR PIXELS:", error);

    return res.status(500).json({
      success: false,
      message: "Erro interno ao listar pixels",
    });
  }
});

router.post("/", requireAdminAuth, async (req, res) => {
  try {
    const payload = normalizePixelPayload(req.body);
    const validationError = validatePixelPayload(payload);

    if (validationError) {
      return res.status(400).json({
        success: false,
        message: validationError,
      });
    }

    const response = await fetch(
      `${env.supabaseUrl}/rest/v1/marketing_pixels`,
      {
        method: "POST",
        headers: {
          ...getSupabaseHeaders(),
          Prefer: "return=representation",
        },
        body: JSON.stringify([
          {
            provider: payload.provider,
            name: payload.name,
            pixel_id: payload.pixelId,
            is_active: payload.isActive,
            enabled_events: payload.enabledEvents,
            page_rules: payload.pageRules,
            extra_config: payload.extraConfig,
            updated_at: new Date().toISOString(),
          },
        ]),
      }
    );

    const data = await response.json().catch(() => null);

    if (!response.ok) {
      return res.status(500).json({
        success: false,
        message: data?.message || data?.error || "Erro ao criar pixel",
      });
    }

    const created = Array.isArray(data) ? data[0] : data;

    return res.status(201).json({
      success: true,
      pixel: normalizePixel(created),
    });
  } catch (error) {
    console.error("ERRO AO CRIAR PIXEL:", error);

    return res.status(500).json({
      success: false,
      message: "Erro interno ao criar pixel",
    });
  }
});

router.put("/:id", requireAdminAuth, async (req, res) => {
  try {
    const id = safeString(req.params.id);
    const payload = normalizePixelPayload(req.body);
    const validationError = validatePixelPayload(payload);

    if (!id) {
      return res.status(400).json({
        success: false,
        message: "ID do pixel não informado",
      });
    }

    if (validationError) {
      return res.status(400).json({
        success: false,
        message: validationError,
      });
    }

    const url = new URL(`${env.supabaseUrl}/rest/v1/marketing_pixels`);
    url.searchParams.set("id", `eq.${id}`);

    const response = await fetch(url.toString(), {
      method: "PATCH",
      headers: {
        ...getSupabaseHeaders(),
        Prefer: "return=representation",
      },
      body: JSON.stringify({
        provider: payload.provider,
        name: payload.name,
        pixel_id: payload.pixelId,
        is_active: payload.isActive,
        enabled_events: payload.enabledEvents,
        page_rules: payload.pageRules,
        extra_config: payload.extraConfig,
        updated_at: new Date().toISOString(),
      }),
    });

    const data = await response.json().catch(() => null);

    if (!response.ok) {
      return res.status(500).json({
        success: false,
        message: data?.message || data?.error || "Erro ao atualizar pixel",
      });
    }

    const updated = Array.isArray(data) ? data[0] : data;

    if (!updated) {
      return res.status(404).json({
        success: false,
        message: "Pixel não encontrado",
      });
    }

    return res.json({
      success: true,
      pixel: normalizePixel(updated),
    });
  } catch (error) {
    console.error("ERRO AO ATUALIZAR PIXEL:", error);

    return res.status(500).json({
      success: false,
      message: "Erro interno ao atualizar pixel",
    });
  }
});

router.delete("/:id", requireAdminAuth, async (req, res) => {
  try {
    const id = safeString(req.params.id);

    if (!id) {
      return res.status(400).json({
        success: false,
        message: "ID do pixel não informado",
      });
    }

    const url = new URL(`${env.supabaseUrl}/rest/v1/marketing_pixels`);
    url.searchParams.set("id", `eq.${id}`);

    const response = await fetch(url.toString(), {
      method: "DELETE",
      headers: getSupabaseHeaders(),
    });

    if (!response.ok) {
      const data = await response.json().catch(() => null);

      return res.status(500).json({
        success: false,
        message: data?.message || data?.error || "Erro ao excluir pixel",
      });
    }

    return res.json({
      success: true,
      message: "Pixel excluído com sucesso",
    });
  } catch (error) {
    console.error("ERRO AO EXCLUIR PIXEL:", error);

    return res.status(500).json({
      success: false,
      message: "Erro interno ao excluir pixel",
    });
  }
});

export default router;