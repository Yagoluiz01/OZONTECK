import { env } from "../../../config/env.js";
import { supabaseAdmin } from "../../../config/supabase.js";
import { recordAuditLog } from "../../audit.service.js";
import { buildAiProductDraftPayload } from "../products/productDraft.js";


function scrub(value) {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  if (!s) return value;
  return s
    .replace(/api[_-]?key\s*[:=]\s*[^\s"']+/gi, "api_key:[REDACTED]")
    .replace(/bearer\s+[^\s"']+/gi, "bearer [REDACTED]")
    .replace(/token\s*[:=]\s*[^\s"']+/gi, "token:[REDACTED]");
}

function toMoney(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? Number(n.toFixed(2)) : fallback;
}

const PRODUCT_WRITE_PERMISSIONS = Object.freeze({
  create: "products.create",
  update: "products.edit",
  delete: "products.delete",
});

function requireProductWritePermission({ permissions = [], operationType } = {}) {
  const required = PRODUCT_WRITE_PERMISSIONS[operationType];
  const granted = new Set(Array.isArray(permissions) ? permissions : []);
  const isMaster = granted.has("*") || granted.has("admin");
  return { ok: Boolean(required) && (isMaster || granted.has(required)), required, isMaster };
}

async function createProductDraft(payload) {
  const draft = buildAiProductDraftPayload(payload);
  const { data, error } = await supabaseAdmin
    .from("products")
    .insert(draft)
    .select("*")
    .single();

  if (error) {
    console.error("[AI_PRODUCT_DRAFT_CREATE_ERROR]", {
      code: error.code || null,
      message: error.message || String(error),
    });

    const createError = new Error(
      error.code === "23505"
        ? "Não foi possível gerar um SKU exclusivo. Tente confirmar novamente."
        : "Não foi possível criar o rascunho do produto."
    );
    createError.statusCode = error.code === "23505" ? 409 : 500;
    throw createError;
  }

  return {
    success: true,
    message: "Rascunho do produto criado com sucesso.",
    product: data,
  };
}

async function recordWriteAuditSafely({
  reqMeta,
  actor,
  action,
  entityId,
  oldValues,
  newValues,
  payload,
} = {}) {
  try {
    await recordAuditLog({
      actor,
      action,
      module: "products",
      entityType: "product",
      entityId,
      description: `${action} de produto via AI`,
      oldValues,
      newValues,
      metadata: {
        source: "ai_agent",
        requestId: reqMeta?.requestId || null,
        rawPayloadPreview: scrub(payload)?.slice?.(0, 800) || null,
      },
    });
  } catch (error) {
    console.error("[AI_PRODUCTS_WRITE_AUDIT_ERROR]", {
      action,
      entityId,
      message: error?.message || String(error),
    });
  }
}

async function getProductById(productId) {
  const id = String(productId || "").trim();
  if (!id) return null;

  const response = await fetch(
    `${env.supabaseUrl}/rest/v1/products?select=*&id=eq.${id}`,
    {
      method: "GET",
      headers: {
        apikey: env.supabaseServiceRoleKey,
        Authorization: `Bearer ${env.supabaseServiceRoleKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
    }
  );

  const data = await response.json().catch(() => null);
  if (!response.ok) return null;

  if (Array.isArray(data)) return data[0] || null;
  return data || null;
}

async function callBackendRoute({ method, path, headers = {}, body } = {}) {
  // Importante: tool roda dentro da API, então chamamos o próprio backend via rotas.
  // Assumimos que env.frontend/app baseUrl do próprio servidor NÃO é necessário, pois.
  // Aqui usamos fetch interno via Supabase não ajuda. Então chamamos o endpoint local
  // usando o mesmo host da API (Render/localhost).

  const baseUrl = env.apiBaseUrl || env.backendUrl || "";
  if (!baseUrl) {
    // fallback: em ambientes onde não há apiBaseUrl, chamamos direto pela Supabase não existe.
    // Como o CRUD real tem validação/tamanho de upload, precisamos do endpoint.
    throw new Error(
      "Config ausente: defina env.apiBaseUrl ou env.backendUrl para a tool executar CRUD real via /products."
    );
  }

  const url = `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;

  const response = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await response.json().catch(() => null);

  return { ok: response.ok, status: response.status, data };
}

// Allowlist: impede tool de executar qualquer coisa além do CRUD real.
function isAllowedCrud({ type } = {}) {
  return ["create", "update", "delete"].includes(type);
}

async function productsWriteTool({
  permissions = [],
  reqMeta,
  actor,
  operation,
} = {}) {
  if (!operation || !isAllowedCrud(operation)) {
    const err = new Error("Invalid products write operation");
    err.statusCode = 400;
    throw err;
  }

  const opType = operation.type;
  const perm = requireProductWritePermission({ permissions, operationType: opType });
  if (!perm.ok) {
    const err = new Error(`products.write blocked: missing ${perm.required || "permission"}`);
    err.statusCode = 403;
    err.required = perm.required;
    throw err;
  }

  const payload = operation.payload || {};

  if (opType === "create") {
    // A IA cria somente um rascunho mínimo. Preço, estoque, imagens e publicação
    // permanecem sob controle manual do administrador no editor de produtos.
    const result = await createProductDraft(payload);

    await recordWriteAuditSafely({
      reqMeta,
      actor,
      action: "product_created",
      entityId: result.product?.id || null,
      newValues: result.product,
      payload,
    });

    return result;
  }

  if (opType === "update") {
    const productId = payload?.id || operation.id || payload?.productId;
    const before = await getProductById(productId);

    const res = await callBackendRoute({
      method: "PUT",
      path: `/api/products/${encodeURIComponent(String(productId))}`,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${operation.authToken || ""}`,
      },
      body: payload,
    });

    if (!res.ok) {
      throw new Error(res.data?.message || "Erro ao atualizar produto");
    }

    const after = res.data?.product || null;

    const oldPrice = toMoney(before?.price, 0);
    const newPrice = toMoney(after?.price, 0);

    await recordWriteAuditSafely({
      reqMeta,
      actor,
      action: "product_updated",
      entityId: productId,
      oldValues: before ? { price: oldPrice, compare_at_price: toMoney(before?.compare_at_price, 0) } : undefined,
      newValues: after ? { price: newPrice, compare_at_price: toMoney(after?.compare_at_price, 0) } : undefined,
      payload,
    });

    return res.data;
  }

  // delete
  const productId = payload?.id || operation.id || payload?.productId;
  const before = await getProductById(productId);

  const res = await callBackendRoute({
    method: "DELETE",
    path: `/api/products/${encodeURIComponent(String(productId))}`,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${operation.authToken || ""}`,
    },
  });

  if (!res.ok) {
    throw new Error(res.data?.message || "Erro ao excluir produto");
  }

  await recordWriteAuditSafely({
    reqMeta,
    actor,
    action: "product_deleted",
    entityId: productId,
    oldValues: before || undefined,
    payload,
  });

  return res.data;
}

export async function productsWriteToolWrapper(args) {
  return productsWriteTool(args);
}
