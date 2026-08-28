import crypto from "node:crypto";

import { supabaseAdmin } from "../config/supabase.js";
import { normalizeInterestCategory } from "../intelligence/interestTaxonomy.js";
import { buildMarketingAudience } from "./marketingAudience.service.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CAMPAIGN_TYPES = new Set([
  "product_launch",
  "product_restock",
  "product_reactivation",
  "product_campaign",
  "promotion",
  "announcement",
]);
const AUDIENCE_MODES = new Set(["smart", "all_opted_in", "category"]);
const EDITABLE_STATUSES = new Set(["draft"]);
const PUBLISHABLE_STATUSES = new Set(["draft", "scheduled", "paused", "failed"]);
const PROMOTION_TYPES = new Set(["percentage", "fixed_amount", "free_shipping"]);
const PROMOTION_STATUSES = new Set([
  "draft",
  "scheduled",
  "active",
  "paused",
  "expired",
  "cancelled",
]);
export const PURGE_MARKETING_CAMPAIGNS_CONFIRMATION =
  "EXCLUIR TODAS AS CAMPANHAS";

function isTruthy(value) {
  return ["1", "true", "yes", "on"].includes(
    String(value || "").trim().toLowerCase()
  );
}

function cleanText(value, maxLength = 500) {
  const text = String(value || "").trim();
  return text ? text.slice(0, maxLength) : "";
}

function fail(message, statusCode = 400, code = "invalid_marketing_campaign") {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function clampInt(value, min, max, fallback) {
  const number = Math.trunc(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function clampMoney(value, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Number(Math.max(0, number).toFixed(2));
}

function unique(values = []) {
  return [...new Set(values.filter(Boolean))];
}

function normalizeUuid(value, fieldName = "identificador") {
  const normalized = cleanText(value, 80).toLowerCase();
  if (!UUID_PATTERN.test(normalized)) {
    throw fail(`${fieldName} inválido.`, 400, "invalid_uuid");
  }
  return normalized;
}

function normalizeDate(value, fieldName, { required = false } = {}) {
  const text = cleanText(value, 80);
  if (!text) {
    if (required) throw fail(`${fieldName} é obrigatório.`, 400, "invalid_date");
    return null;
  }
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) {
    throw fail(`${fieldName} inválido.`, 400, "invalid_date");
  }
  return date.toISOString();
}

export function normalizeStoreDestinationUrl(
  value,
  storefrontUrl = process.env.STORE_FRONTEND_URL || process.env.FRONTEND_URL
) {
  const destination = cleanText(value, 1500);
  if (!destination) return null;

  try {
    const store = new URL(String(storefrontUrl || "").replace(/\/+$/, ""));
    const resolved = new URL(destination, `${store.origin}/`);
    if (resolved.protocol !== "https:" && resolved.protocol !== "http:") {
      throw new Error("protocol");
    }
    if (resolved.origin !== store.origin) {
      throw new Error("origin");
    }
    resolved.hash = "";
    return resolved.toString();
  } catch {
    throw fail(
      "O destino da campanha precisa pertencer ao domínio oficial da loja.",
      400,
      "unsafe_campaign_destination"
    );
  }
}

function normalizeImageUrl(value) {
  const imageUrl = cleanText(value, 1500);
  if (!imageUrl) return null;
  try {
    const parsed = new URL(imageUrl);
    if (parsed.protocol !== "https:") throw new Error("protocol");

    const allowedOrigins = unique([
      process.env.STORE_FRONTEND_URL,
      process.env.FRONTEND_URL,
      process.env.SUPABASE_URL,
      ...String(process.env.MARKETING_IMAGE_ALLOWED_ORIGINS || "").split(","),
    ]).flatMap((entry) => {
      try {
        return [new URL(String(entry || "").trim()).origin];
      } catch {
        return [];
      }
    });
    if (!allowedOrigins.includes(parsed.origin)) throw new Error("origin");
    return parsed.toString();
  } catch {
    throw fail(
      "A imagem precisa usar HTTPS e pertencer à loja ou ao armazenamento autorizado.",
      400,
      "invalid_image_url"
    );
  }
}

function normalizeProductIds(values) {
  if (!Array.isArray(values)) return [];
  return unique(values.map((value) => normalizeUuid(value, "Produto"))).slice(0, 50);
}

export function normalizeMarketingCampaignInput(input = {}, { partial = false } = {}) {
  const campaignType = cleanText(input.campaign_type, 60).toLowerCase();
  const audienceMode = cleanText(input.audience_mode, 40).toLowerCase();
  const name = cleanText(input.name, 160);
  const title = cleanText(input.title, 120);
  const body = cleanText(input.body, 360);
  const ctaLabel = cleanText(input.cta_label, 50);
  const rawCategories = Array.isArray(input.category_keys) ? input.category_keys : [];
  const categoryKeys = unique(rawCategories.map(normalizeInterestCategory)).slice(0, 20);
  const channels = unique(
    (Array.isArray(input.channels) ? input.channels : ["web_push"])
      .map((item) => cleanText(item, 30).toLowerCase())
      .filter((item) => item === "web_push" || item === "email")
  );

  if (!partial || Object.hasOwn(input, "campaign_type")) {
    if (!CAMPAIGN_TYPES.has(campaignType)) {
      throw fail("Tipo de campanha inválido.", 400, "invalid_campaign_type");
    }
  }
  if (!partial || Object.hasOwn(input, "audience_mode")) {
    if (!AUDIENCE_MODES.has(audienceMode || "smart")) {
      throw fail("Público da campanha inválido.", 400, "invalid_audience_mode");
    }
  }
  if (!partial || Object.hasOwn(input, "name")) {
    if (!name) throw fail("Nome da campanha é obrigatório.", 400, "campaign_name_required");
  }
  if (!partial || Object.hasOwn(input, "title")) {
    if (!title) throw fail("Título da notificação é obrigatório.", 400, "campaign_title_required");
  }
  if (!partial || Object.hasOwn(input, "body")) {
    if (!body) throw fail("Texto da notificação é obrigatório.", 400, "campaign_body_required");
  }
  if (!partial || Object.hasOwn(input, "channels")) {
    if (!channels.length) throw fail("Escolha pelo menos um canal.", 400, "campaign_channel_required");
  }
  if ((audienceMode || input.audience_mode) === "category" && categoryKeys.length === 0) {
    throw fail(
      "Campanhas por categoria precisam de ao menos uma categoria.",
      400,
      "campaign_category_required"
    );
  }

  const payload = {};
  const assign = (key, value) => {
    if (!partial || Object.hasOwn(input, key)) payload[key] = value;
  };

  assign("name", name);
  assign("campaign_type", campaignType);
  assign("audience_mode", audienceMode || "smart");
  assign("category_keys", categoryKeys);
  assign("channels", channels.length ? channels : ["web_push"]);
  assign("title", title);
  assign("body", body);
  assign("cta_label", ctaLabel || "Ver novidade");
  assign("destination_url", normalizeStoreDestinationUrl(input.destination_url));
  assign("image_url", normalizeImageUrl(input.image_url));
  assign("timezone", cleanText(input.timezone, 80) || "America/Bahia");
  assign("dry_run", input.dry_run !== false);
  assign("discovery_enabled", input.discovery_enabled !== false);
  assign("daily_cap", clampInt(input.daily_cap, 0, 20, 1));
  assign("weekly_cap", clampInt(input.weekly_cap, 0, 100, 2));

  return {
    campaign: payload,
    productIds: normalizeProductIds(input.product_ids),
  };
}

export function normalizeMarketingPromotionInput(input = {}, { partial = false } = {}) {
  const name = cleanText(input.name, 160);
  const discountType = cleanText(input.discount_type, 40).toLowerCase();
  const status = cleanText(input.status, 40).toLowerCase() || "draft";
  const code = cleanText(input.code, 40).toUpperCase().replace(/\s+/g, "");
  const startsAt = normalizeDate(input.starts_at, "Início", { required: !partial });
  const endsAt = normalizeDate(input.ends_at, "Encerramento", { required: !partial });

  if (!partial || Object.hasOwn(input, "name")) {
    if (!name) throw fail("Nome da promoção é obrigatório.", 400, "promotion_name_required");
  }
  if (!partial || Object.hasOwn(input, "discount_type")) {
    if (!PROMOTION_TYPES.has(discountType)) {
      throw fail("Tipo de desconto inválido.", 400, "invalid_promotion_type");
    }
  }
  if (!partial || Object.hasOwn(input, "status")) {
    if (!PROMOTION_STATUSES.has(status)) {
      throw fail("Status da promoção inválido.", 400, "invalid_promotion_status");
    }
  }
  if (code && !/^[A-Z0-9][A-Z0-9_-]{2,39}$/.test(code)) {
    throw fail("Código de cupom inválido.", 400, "invalid_promotion_code");
  }
  if (startsAt && endsAt && Date.parse(endsAt) <= Date.parse(startsAt)) {
    throw fail("O encerramento precisa ser posterior ao início.", 400, "invalid_promotion_period");
  }

  const value = discountType === "free_shipping"
    ? 0
    : clampMoney(input.discount_value, 0);
  if ((!partial || Object.hasOwn(input, "discount_value")) && discountType !== "free_shipping") {
    if (value <= 0 || (discountType === "percentage" && value > 100)) {
      throw fail("Valor do desconto inválido.", 400, "invalid_promotion_value");
    }
  }

  const payload = {};
  const assign = (key, value) => {
    if (!partial || Object.hasOwn(input, key)) payload[key] = value;
  };
  assign("campaign_id", input.campaign_id ? normalizeUuid(input.campaign_id, "Campanha") : null);
  assign("name", name);
  assign("code", code || null);
  assign("discount_type", discountType);
  assign("discount_value", value);
  assign("minimum_order_amount", clampMoney(input.minimum_order_amount, 0));
  assign(
    "maximum_discount_amount",
    input.maximum_discount_amount === null || input.maximum_discount_amount === ""
      ? null
      : clampMoney(input.maximum_discount_amount, 0)
  );
  assign(
    "usage_limit",
    input.usage_limit === null || input.usage_limit === ""
      ? null
      : clampInt(input.usage_limit, 1, 1000000, 1)
  );
  assign("per_recipient_limit", clampInt(input.per_recipient_limit, 1, 100, 1));
  assign("starts_at", startsAt);
  assign("ends_at", endsAt);
  assign("is_automatic", input.is_automatic === true);
  assign("is_stackable", input.is_stackable === true);
  assign("status", status);

  return {
    promotion: payload,
    productIds: normalizeProductIds(input.product_ids),
    categoryKeys: unique(
      (Array.isArray(input.category_keys) ? input.category_keys : [])
        .map(normalizeInterestCategory)
    ).slice(0, 50),
  };
}

async function loadProducts(productIds, client) {
  if (!productIds.length) return [];
  const { data, error } = await client
    .from("products")
    .select(
      "id,name,sku,category,price,stock_quantity,status,image_url,image_thumb_url,image_card_url,promotional_min_price"
    )
    .in("id", productIds);
  if (error) throw error;
  if ((data || []).length !== productIds.length) {
    throw fail("Um ou mais produtos não foram encontrados.", 404, "campaign_product_not_found");
  }
  return data || [];
}

export async function listMarketingCampaignProducts(
  { limit = 500 } = {},
  { client = supabaseAdmin } = {}
) {
  const safeLimit = clampInt(limit, 1, 1000, 500);
  const { data, error } = await client
    .from("products")
    .select(
      "id,name,sku,category,status,stock_quantity,image_url,image_thumb_url,image_card_url"
    )
    .order("name", { ascending: true })
    .limit(safeLimit);
  if (error) throw error;
  return data || [];
}

function productSnapshot(product) {
  return {
    id: product.id,
    name: product.name,
    sku: product.sku,
    category: product.category,
    price: Number(product.price || 0),
    stock_quantity: Number(product.stock_quantity || 0),
    status: product.status,
    image_url: product.image_url || null,
    image_thumb_url: product.image_thumb_url || null,
    image_card_url: product.image_card_url || null,
  };
}

function campaignItemsPayload(products) {
  return products.map((product) => ({
    product_id: product.id,
    product_snapshot: productSnapshot(product),
  }));
}

async function saveCampaignDraftAtomic(
  { campaignId = null, expectedVersion = null, campaign, products, actorId },
  client
) {
  const { data, error } = await client.rpc("save_marketing_campaign_draft", {
    p_campaign_id: campaignId,
    p_expected_version: expectedVersion,
    p_campaign: campaign,
    p_items: campaignItemsPayload(products),
    p_actor_id: actorId || null,
  });
  if (error) {
    if (String(error.code || "") === "40001") {
      throw fail(
        "A campanha foi alterada em outra sessão. Recarregue antes de salvar.",
        409,
        "campaign_version_conflict"
      );
    }
    throw error;
  }
  return Array.isArray(data) ? data[0] : data;
}

export async function createMarketingCampaign(
  input,
  { actorId, client = supabaseAdmin } = {}
) {
  const { campaign: normalized, productIds } = normalizeMarketingCampaignInput(input);
  const products = await loadProducts(productIds, client);
  const categoryKeys = unique([
    ...(normalized.category_keys || []),
    ...products.map((product) => normalizeInterestCategory(product.category)),
  ]);
  const payload = {
    ...normalized,
    category_keys: categoryKeys,
    metadata: { created_from: "admin" },
  };
  const campaign = await saveCampaignDraftAtomic(
    { campaign: payload, products, actorId },
    client
  );
  return getMarketingCampaign(campaign.id, { client });
}

export async function getMarketingCampaign(
  campaignId,
  { client = supabaseAdmin } = {}
) {
  const id = normalizeUuid(campaignId, "Campanha");
  const [campaignResult, itemsResult, promotionResult, metricsResult] = await Promise.all([
    client.from("marketing_campaigns").select("*").eq("id", id).maybeSingle(),
    client
      .from("marketing_campaign_items")
      .select("id,product_id,position,product_snapshot")
      .eq("campaign_id", id)
      .order("position", { ascending: true }),
    client.from("marketing_promotions").select("*").eq("campaign_id", id).maybeSingle(),
    client.from("marketing_campaign_metrics").select("*").eq("campaign_id", id).maybeSingle(),
  ]);
  for (const result of [campaignResult, itemsResult, promotionResult, metricsResult]) {
    if (result.error) throw result.error;
  }
  if (!campaignResult.data) {
    throw fail("Campanha não encontrada.", 404, "campaign_not_found");
  }
  return {
    ...campaignResult.data,
    items: itemsResult.data || [],
    promotion: promotionResult.data || null,
    metrics: metricsResult.data || null,
  };
}

export async function deleteMarketingCampaign(
  campaignId,
  { client = supabaseAdmin } = {}
) {
  const id = normalizeUuid(campaignId, "Campanha");
  const campaignResult = await client
    .from("marketing_campaigns")
    .select("id,name,status,published_at,last_simulated_at")
    .eq("id", id)
    .maybeSingle();
  if (campaignResult.error) throw campaignResult.error;
  if (!campaignResult.data) {
    throw fail("Campanha não encontrada.", 404, "campaign_not_found");
  }

  const campaign = campaignResult.data;
  if (
    campaign.status !== "draft" ||
    campaign.published_at ||
    campaign.last_simulated_at
  ) {
    throw fail(
      "Somente um rascunho que nunca foi processado pode ser excluído. Campanhas com histórico devem ser preservadas.",
      409,
      "campaign_has_history"
    );
  }

  const historyResult = await client
    .from("marketing_campaign_jobs")
    .select("id", { count: "exact", head: true })
    .eq("campaign_id", id);
  if (historyResult.error) throw historyResult.error;
  if (Number(historyResult.count || 0) > 0) {
    throw fail(
      "Esta campanha já possui histórico de processamento e não pode ser excluída.",
      409,
      "campaign_has_history"
    );
  }

  const deleteResult = await client
    .from("marketing_campaigns")
    .delete()
    .eq("id", id)
    .eq("status", "draft")
    .is("published_at", null)
    .is("last_simulated_at", null)
    .select("id,name")
    .maybeSingle();
  if (deleteResult.error) throw deleteResult.error;
  if (!deleteResult.data) {
    throw fail(
      "O estado da campanha mudou. Recarregue antes de excluir.",
      409,
      "campaign_state_conflict"
    );
  }
  return deleteResult.data;
}

export async function purgeMarketingCampaignData(
  input = {},
  { client = supabaseAdmin } = {}
) {
  const confirmation = cleanText(input.confirmation, 80);
  if (confirmation !== PURGE_MARKETING_CAMPAIGNS_CONFIRMATION) {
    throw fail(
      `Digite exatamente ${PURGE_MARKETING_CAMPAIGNS_CONFIRMATION} para confirmar.`,
      400,
      "invalid_campaign_purge_confirmation"
    );
  }

  const result = await client.rpc("purge_marketing_campaign_data", {
    p_confirmation: confirmation,
  });
  if (result.error) throw result.error;
  return result.data || {};
}

export async function listMarketingCampaigns(
  filters = {},
  { client = supabaseAdmin } = {}
) {
  const page = clampInt(filters.page, 1, 100000, 1);
  const limit = clampInt(filters.limit, 1, 100, 20);
  const from = (page - 1) * limit;
  const status = cleanText(filters.status, 40).toLowerCase();
  const type = cleanText(filters.type, 60).toLowerCase();
  const search = cleanText(filters.search, 120);

  let query = client
    .from("marketing_campaigns")
    .select("*", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(from, from + limit - 1);
  if (status) query = query.eq("status", status);
  if (type) query = query.eq("campaign_type", type);
  if (search) query = query.ilike("name", `%${search.replace(/[%_,]/g, "")}%`);

  const { data, error, count } = await query;
  if (error) throw error;
  const campaigns = data || [];
  const ids = campaigns.map((item) => item.id);
  let metrics = [];
  if (ids.length) {
    const metricsResult = await client
      .from("marketing_campaign_metrics")
      .select("*")
      .in("campaign_id", ids);
    if (metricsResult.error) throw metricsResult.error;
    metrics = metricsResult.data || [];
  }
  const metricsById = new Map(metrics.map((item) => [item.campaign_id, item]));

  return {
    campaigns: campaigns.map((campaign) => ({
      ...campaign,
      metrics: metricsById.get(campaign.id) || null,
    })),
    pagination: {
      page,
      limit,
      total: Number(count || 0),
      pages: Math.max(1, Math.ceil(Number(count || 0) / limit)),
    },
  };
}

export async function updateMarketingCampaign(
  campaignId,
  input,
  { actorId, client = supabaseAdmin } = {}
) {
  const existing = await getMarketingCampaign(campaignId, { client });
  if (!EDITABLE_STATUSES.has(existing.status)) {
    throw fail(
      "Somente campanhas em rascunho podem ser editadas.",
      409,
      "campaign_not_editable"
    );
  }
  if (input.version && Number(input.version) !== Number(existing.version)) {
    throw fail(
      "A campanha foi alterada em outra sessão. Recarregue antes de salvar.",
      409,
      "campaign_version_conflict"
    );
  }

  const mergedInput = {
    ...existing,
    ...input,
    product_ids: Object.hasOwn(input, "product_ids")
      ? input.product_ids
      : existing.items.map((item) => item.product_id),
  };
  const { campaign: normalized, productIds } = normalizeMarketingCampaignInput(mergedInput);
  const products = await loadProducts(productIds, client);
  normalized.category_keys = unique([
    ...(normalized.category_keys || []),
    ...products.map((product) => normalizeInterestCategory(product.category)),
  ]);

  await saveCampaignDraftAtomic(
    {
      campaignId: existing.id,
      expectedVersion: Number(existing.version || 1),
      campaign: normalized,
      products,
      actorId,
    },
    client
  );
  return getMarketingCampaign(existing.id, { client });
}

export async function estimateMarketingCampaignAudience(
  campaignId,
  { client = supabaseAdmin } = {}
) {
  const campaign = await getMarketingCampaign(campaignId, { client });
  const estimate = await buildMarketingAudience(
    { campaign, items: campaign.items, includeRecipients: false },
    { client }
  );
  return {
    campaignId: campaign.id,
    calculatedAt: new Date().toISOString(),
    ...estimate,
  };
}

function assertCampaignReady(campaign) {
  if (!PUBLISHABLE_STATUSES.has(campaign.status)) {
    throw fail("A campanha não pode ser publicada neste estado.", 409, "campaign_not_publishable");
  }
  if (!campaign.channels?.includes("web_push")) {
    throw fail("A primeira versão segura exige o canal Web Push.", 409, "web_push_required");
  }
  if (campaign.channels.some((channel) => channel !== "web_push")) {
    throw fail(
      "E-mail ainda não está liberado no novo motor de campanhas.",
      409,
      "campaign_channel_not_ready"
    );
  }
  if (
    campaign.campaign_type !== "announcement" &&
    (!campaign.items || campaign.items.length === 0)
  ) {
    throw fail("Selecione ao menos um produto para publicar.", 409, "campaign_product_required");
  }
  if (
    campaign.campaign_type === "promotion" &&
    !["1", "true", "yes", "on"].includes(
      String(process.env.MARKETING_PROMOTIONS_CHECKOUT_ENABLED || "false").toLowerCase()
    )
  ) {
    throw fail(
      "Promoções permanecerão em rascunho até a validação do desconto no checkout.",
      409,
      "promotion_checkout_not_ready"
    );
  }
}

async function assertProductsReady(campaign, client) {
  const productIds = campaign.items.map((item) => item.product_id);
  if (!productIds.length) return;
  const products = await loadProducts(productIds, client);
  const unavailable = products.filter(
    (product) =>
      cleanText(product.status, 30).toLowerCase() !== "active" ||
      Number(product.stock_quantity || 0) <= 0
  );
  if (unavailable.length) {
    throw fail(
      `Produtos indisponíveis: ${unavailable.map((item) => item.name).join(", ")}.`,
      409,
      "campaign_product_unavailable"
    );
  }
}

export async function publishMarketingCampaign(
  campaignId,
  input = {},
  { actorId, client = supabaseAdmin } = {}
) {
  const campaign = await getMarketingCampaign(campaignId, { client });
  assertCampaignReady(campaign);
  await assertProductsReady(campaign, client);

  const scheduledAt = normalizeDate(
    Object.hasOwn(input, "scheduled_at")
      ? input.scheduled_at
      : campaign.scheduled_at,
    "Agendamento"
  );
  const nowMs = Date.now();
  const isScheduled = scheduledAt && Date.parse(scheduledAt) > nowMs + 15000;
  const nextStatus = isScheduled ? "scheduled" : "queued";
  const dryRun = input.dry_run === undefined
    ? campaign.dry_run
    : input.dry_run !== false;

  const { data, error } = await client.rpc("publish_marketing_campaign", {
    p_campaign_id: campaign.id,
    p_expected_version: Number(campaign.version || 1),
    p_status: nextStatus,
    p_scheduled_at: isScheduled ? scheduledAt : null,
    p_dry_run: dryRun,
    p_actor_id: actorId || null,
  });
  if (error) {
    if (String(error.code || "") === "40001") {
      throw fail(
        "A campanha foi alterada em outra sessão. Recarregue antes de publicar.",
        409,
        "campaign_version_conflict"
      );
    }
    throw error;
  }

  return Array.isArray(data) ? data[0] : data;
}

export async function pauseMarketingCampaign(
  campaignId,
  { actorId, client = supabaseAdmin } = {}
) {
  const campaign = await getMarketingCampaign(campaignId, { client });
  if (!["scheduled", "queued", "processing"].includes(campaign.status)) {
    throw fail("Esta campanha não pode ser pausada.", 409, "campaign_not_pauseable");
  }
  const { data, error } = await client
    .from("marketing_campaigns")
    .update({
      status: "paused",
      updated_by: actorId || null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", campaign.id)
    .in("status", ["scheduled", "queued", "processing"])
    .select("*")
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    throw fail(
      "O estado da campanha mudou. Recarregue antes de pausar.",
      409,
      "campaign_state_conflict"
    );
  }
  return data;
}

export async function cancelMarketingCampaign(
  campaignId,
  { actorId, client = supabaseAdmin } = {}
) {
  const campaign = await getMarketingCampaign(campaignId, { client });
  if (["completed", "cancelled"].includes(campaign.status)) {
    throw fail("Esta campanha já foi encerrada.", 409, "campaign_already_closed");
  }
  const now = new Date().toISOString();
  const campaignResult = await client
    .from("marketing_campaigns")
    .update({
      status: "cancelled",
      cancelled_at: now,
      updated_by: actorId || null,
      updated_at: now,
    })
    .eq("id", campaign.id)
    .in("status", ["draft", "scheduled", "queued", "processing", "paused", "failed"])
    .select("*")
    .maybeSingle();
  if (campaignResult.error) throw campaignResult.error;
  if (!campaignResult.data) {
    throw fail(
      "O estado da campanha mudou. Recarregue antes de cancelar.",
      409,
      "campaign_state_conflict"
    );
  }

  const jobResult = await client
    .from("marketing_campaign_jobs")
    .update({ status: "cancelled", completed_at: now, updated_at: now })
    .eq("campaign_id", campaign.id)
    .in("status", ["queued", "retry"]);
  if (jobResult.error) throw jobResult.error;
  return campaignResult.data;
}

function emptyMetrics() {
  return {
    selected_recipients: 0,
    accepted_recipients: 0,
    failed_recipients: 0,
    device_attempts: 0,
    provider_accepted_attempts: 0,
    failed_attempts: 0,
    unique_clicks: 0,
    total_clicks: 0,
    conversions: 0,
    attributed_revenue: 0,
    ctr_percent: 0,
  };
}

export async function getMarketingOverview(
  { days = 30 } = {},
  { client = supabaseAdmin } = {}
) {
  const safeDays = clampInt(days, 1, 365, 30);
  const since = new Date(Date.now() - safeDays * 24 * 60 * 60 * 1000).toISOString();
  const campaignsResult = await client
    .from("marketing_campaigns")
    .select("id,name,campaign_type,status,created_at,scheduled_at")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(1000);
  if (campaignsResult.error) throw campaignsResult.error;

  const campaigns = campaignsResult.data || [];
  const campaignIds = campaigns.map((item) => item.id);
  const emptyResult = Promise.resolve({ data: [], error: null });
  const [metricsResult, subscriptionsResult, dailyMetricsResult] = await Promise.all([
    campaignIds.length
      ? client.from("marketing_campaign_metrics").select("*").in("campaign_id", campaignIds)
      : emptyResult,
    client
      .from("customer_marketing_push_subscriptions")
      .select("id", { count: "exact", head: true })
      .eq("is_active", true)
      .is("revoked_at", null),
    campaignIds.length
      ? client
        .from("marketing_campaign_daily_metrics")
        .select("campaign_id,metric_date,clicks,conversions")
        .in("campaign_id", campaignIds)
        .gte("metric_date", since.slice(0, 10))
        .order("metric_date", { ascending: true })
      : emptyResult,
  ]);
  for (const result of [metricsResult, subscriptionsResult, dailyMetricsResult]) {
    if (result.error) throw result.error;
  }

  const totals = (metricsResult.data || [])
    .reduce((accumulator, item) => {
      for (const key of Object.keys(accumulator)) {
        if (key === "ctr_percent") continue;
        accumulator[key] += Number(item[key] || 0);
      }
      return accumulator;
    }, emptyMetrics());
  totals.ctr_percent = totals.accepted_recipients > 0
    ? Number(((totals.unique_clicks / totals.accepted_recipients) * 100).toFixed(2))
    : 0;

  const timeline = new Map();
  for (let offset = safeDays - 1; offset >= 0; offset -= 1) {
    const key = new Date(Date.now() - offset * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    timeline.set(key, { date: key, clicks: 0, conversions: 0 });
  }
  for (const metric of dailyMetricsResult.data || []) {
    const key = cleanText(metric.metric_date, 40).slice(0, 10);
    if (!timeline.has(key)) continue;
    timeline.get(key).clicks += Number(metric.clicks || 0);
    timeline.get(key).conversions += Number(metric.conversions || 0);
  }

  return {
    periodDays: safeDays,
    activeSubscriptions: Number(subscriptionsResult.count || 0),
    campaignCount: campaigns.length,
    statusCounts: campaigns.reduce((accumulator, item) => {
      accumulator[item.status] = (accumulator[item.status] || 0) + 1;
      return accumulator;
    }, {}),
    totals,
    timeline: [...timeline.values()],
    recentCampaigns: campaigns.slice(0, 8),
  };
}

export async function getMarketingCampaignAnalytics(
  campaignId,
  { client = supabaseAdmin } = {}
) {
  const campaign = await getMarketingCampaign(campaignId, { client });
  const { data: events, error } = await client
    .from("marketing_campaign_events")
    .select("event_type,occurred_at")
    .eq("campaign_id", campaign.id)
    .order("occurred_at", { ascending: true })
    .limit(10000);
  if (error) throw error;

  const byType = (events || []).reduce((accumulator, event) => {
    accumulator[event.event_type] = (accumulator[event.event_type] || 0) + 1;
    return accumulator;
  }, {});
  return {
    campaign,
    metrics: campaign.metrics || emptyMetrics(),
    eventCounts: byType,
    events: events || [],
  };
}

async function replacePromotionScopes(promotionId, productIds, categoryKeys, client) {
  const [deleteProducts, deleteCategories] = await Promise.all([
    client.from("marketing_promotion_products").delete().eq("promotion_id", promotionId),
    client.from("marketing_promotion_categories").delete().eq("promotion_id", promotionId),
  ]);
  if (deleteProducts.error) throw deleteProducts.error;
  if (deleteCategories.error) throw deleteCategories.error;

  if (productIds.length) {
    const { error } = await client.from("marketing_promotion_products").insert(
      productIds.map((productId) => ({ promotion_id: promotionId, product_id: productId }))
    );
    if (error) throw error;
  }
  if (categoryKeys.length) {
    const { error } = await client.from("marketing_promotion_categories").insert(
      categoryKeys.map((categoryKey) => ({ promotion_id: promotionId, category_key: categoryKey }))
    );
    if (error) throw error;
  }
}

export async function createMarketingPromotion(
  input,
  { actorId, client = supabaseAdmin } = {}
) {
  const normalized = normalizeMarketingPromotionInput(input);
  await loadProducts(normalized.productIds, client);
  const { data, error } = await client
    .from("marketing_promotions")
    .insert({
      ...normalized.promotion,
      status: "draft",
      created_by: actorId || null,
      updated_by: actorId || null,
    })
    .select("*")
    .single();
  if (error) throw error;
  try {
    await replacePromotionScopes(
      data.id,
      normalized.productIds,
      normalized.categoryKeys,
      client
    );
  } catch (scopeError) {
    await client.from("marketing_promotions").delete().eq("id", data.id);
    throw scopeError;
  }
  return data;
}

export async function listMarketingPromotions(
  filters = {},
  { client = supabaseAdmin } = {}
) {
  const status = cleanText(filters.status, 40).toLowerCase();
  let query = client
    .from("marketing_promotions")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(200);
  if (status) query = query.eq("status", status);
  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

export async function getMarketingAutomationSettings(
  { client = supabaseAdmin } = {}
) {
  const { data, error } = await client
    .from("marketing_automation_settings")
    .select("*")
    .eq("id", 1)
    .single();
  if (error) throw error;
  return data;
}

export async function updateMarketingAutomationSettings(
  input = {},
  { actorId, client = supabaseAdmin } = {}
) {
  const enabled = input.enabled === true;
  const autoPublish = input.auto_publish === true;
  const defaultDryRun = input.default_dry_run !== false;
  if (autoPublish && !enabled) {
    throw fail(
      "Ative o motor antes de habilitar a publicação automática.",
      409,
      "marketing_automation_disabled"
    );
  }
  if (
    enabled &&
    autoPublish &&
    !defaultDryRun &&
    !isTruthy(process.env.MARKETING_AUTOMATION_REAL_SEND_ENABLED)
  ) {
    throw fail(
      "A automação real permanece bloqueada pela configuração de segurança da API.",
      409,
      "marketing_automation_real_send_locked"
    );
  }

  const payload = {
    enabled,
    auto_publish: autoPublish,
    default_dry_run: defaultDryRun,
    notify_product_launch: input.notify_product_launch !== false,
    notify_product_reactivation: input.notify_product_reactivation !== false,
    notify_product_restock: input.notify_product_restock !== false,
    discovery_enabled: input.discovery_enabled !== false,
    restock_cooldown_hours: clampInt(input.restock_cooldown_hours, 1, 2160, 72),
    daily_cap: clampInt(input.daily_cap, 0, 20, 1),
    weekly_cap: clampInt(input.weekly_cap, 0, 100, 2),
    updated_by: actorId || null,
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await client
    .from("marketing_automation_settings")
    .update(payload)
    .eq("id", 1)
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

export function createMarketingClickToken() {
  const token = crypto.randomBytes(32).toString("base64url");
  return {
    token,
    tokenHash: crypto.createHash("sha256").update(token).digest("hex"),
  };
}

export function createMarketingClickTokenForRecipient(campaignId, recipientId) {
  const safeCampaignId = normalizeUuid(campaignId, "Campanha");
  const safeRecipientId = normalizeUuid(recipientId, "Destinatário");
  const configuredSecret = cleanText(process.env.MARKETING_CLICK_TOKEN_SECRET, 500);
  const secret = configuredSecret || (
    process.env.NODE_ENV === "production" ? "" : cleanText(process.env.JWT_SECRET, 500)
  );
  if (secret.length < 24) {
    throw fail(
      "O segredo de tracking das campanhas não está configurado.",
      503,
      "marketing_click_secret_missing"
    );
  }
  const token = crypto
    .createHmac("sha256", secret)
    .update(`${safeCampaignId}:${safeRecipientId}`)
    .digest("base64url");
  return {
    token,
    tokenHash: crypto.createHash("sha256").update(token).digest("hex"),
  };
}

export function hashMarketingClickToken(token) {
  return crypto
    .createHash("sha256")
    .update(cleanText(token, 120))
    .digest("hex");
}

export async function registerMarketingCampaignClick(
  { token, userAgent = "", ipAddress = "" } = {},
  { client = supabaseAdmin } = {}
) {
  const safeToken = cleanText(token, 120);
  if (!/^[A-Za-z0-9_-]{40,100}$/.test(safeToken)) {
    throw fail("Link de campanha inválido.", 404, "campaign_click_not_found");
  }
  const metadata = {
    user_agent: cleanText(userAgent, 300) || null,
    ip_hash: ipAddress && cleanText(process.env.MARKETING_CLICK_TOKEN_SECRET, 500)
      ? crypto
        .createHmac("sha256", cleanText(process.env.MARKETING_CLICK_TOKEN_SECRET, 500))
        .update(cleanText(ipAddress, 100))
        .digest("hex")
      : null,
  };
  const { data, error } = await client.rpc("register_marketing_campaign_click", {
    p_token_hash: hashMarketingClickToken(safeToken),
    p_metadata: metadata,
  });
  if (error) throw error;
  const result = data?.[0] || null;
  if (!result?.destination_url) {
    throw fail("Link de campanha inválido ou expirado.", 404, "campaign_click_not_found");
  }
  return result;
}
