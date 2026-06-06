import { recordAuditLog } from "../services/audit.service.js";

const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const AUDITED_PREFIXES = [
  "/api/admin/",
  "/api/products",
  "/api/categories",
  "/api/orders",
  "/api/customers",
  "/api/settings",
  "/api/shipping",
];

const EXTRA_AUDITED_PATTERNS = [
  /^\/api\/store\/orders\/[^/]+\/process-paid$/,
];

const IGNORED_PATTERNS = [
  /^\/api\/admin\/audit(?:\/|$)/,
  /^\/api\/admin\/notifications\/[^/]+\/read$/,
  /^\/api\/admin\/notifications\/read-all$/,
  /^\/api\/admin\/push\/subscribe$/,
  /^\/api\/admin\/pricing\/calculate$/,
  /^\/api\/admin\/pricing\/simulate-payment-fee$/,
];

const SENSITIVE_KEY_PATTERN =
  /(password|senha|token|authorization|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|cvv|card[_-]?number|numero[_-]?cartao|cpf|document|signature)/i;

const LARGE_CONTENT_KEY_PATTERN =
  /(base64|data[_-]?url|image[_-]?data|photo[_-]?data|video[_-]?data|file[_-]?data|binary|buffer)/i;

const MODULE_LABELS = {
  admin_access: "acessos administrativos",
  affiliates: "afiliados",
  community: "comunidade",
  marketing_kit: "materiais de divulgação",
  financial: "financeiro",
  fiscal: "fiscal",
  marketing_pixels: "pixels de marketing",
  notifications: "notificações",
  pricing: "precificação",
  push: "notificações push",
  store_theme: "identidade visual",
  products: "produtos",
  categories: "categorias",
  orders: "pedidos",
  customers: "clientes",
  settings: "configurações",
  shipping: "frete e logística",
  admin: "administração",
};

const ACTION_LABELS = {
  create: "criou um registro",
  update: "alterou um registro",
  delete: "excluiu um registro",
  approve: "aprovou um registro",
  reject: "recusou um registro",
  ban: "bloqueou um registro",
  unban: "reativou um registro",
  pay: "registrou um pagamento",
  payout: "registrou um pagamento",
  sync: "sincronizou um registro",
  apply: "aplicou uma alteração",
  process: "processou uma ação",
  publish: "publicou um registro",
  hide: "ocultou um registro",
  pin: "fixou um registro",
  unpin: "desafixou um registro",
  cleanup: "executou uma limpeza",
  upload: "enviou um arquivo",
  test: "executou um teste",
  execute: "executou uma ação",
};

function normalizePath(req) {
  return String(req?.originalUrl || req?.url || req?.path || "")
    .split("?")[0]
    .replace(/\/+$/, "") || "/";
}

function isAuditedPath(pathname) {
  if (EXTRA_AUDITED_PATTERNS.some((pattern) => pattern.test(pathname))) return true;
  return AUDITED_PREFIXES.some(
    (prefix) => pathname === prefix.replace(/\/$/, "") || pathname.startsWith(prefix)
  );
}

function shouldIgnorePath(pathname) {
  return IGNORED_PATTERNS.some((pattern) => pattern.test(pathname));
}

function truncateText(value, maxLength = 240) {
  const text = String(value ?? "");
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}…`;
}

function sanitizeValue(value, depth = 0) {
  if (depth > 4) return "[profundidade limitada]";

  if (value === null || value === undefined) return value;
  if (typeof value === "string") return truncateText(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return String(value);

  if (Array.isArray(value)) {
    return value.slice(0, 12).map((item) => sanitizeValue(item, depth + 1));
  }

  if (typeof value === "object") {
    const entries = Object.entries(value).slice(0, 40);

    return Object.fromEntries(
      entries.map(([key, item]) => {
        if (SENSITIVE_KEY_PATTERN.test(key)) return [key, "[protegido]"];
        if (LARGE_CONTENT_KEY_PATTERN.test(key)) return [key, "[conteúdo omitido]"];
        return [key, sanitizeValue(item, depth + 1)];
      })
    );
  }

  return truncateText(value);
}

function getChangedFields(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return [];

  return Object.keys(body)
    .filter((key) => !SENSITIVE_KEY_PATTERN.test(key))
    .slice(0, 60);
}

function normalizeActor(req) {
  const source = req?.admin || req?.auth?.admin || null;
  if (!source) return null;

  const actor = {
    id: source.id || source.admin_id || null,
    userId: source.userId || source.user_id || source.auth_user_id || source.sub || null,
    email: source.email || null,
    full_name: source.full_name || source.name || null,
    role: source.role || null,
  };

  if (!actor.id && !actor.email) return null;
  return actor;
}

function getModule(pathname) {
  if (/^\/api\/admin\/access-requests/.test(pathname)) return "admin_access";
  if (/^\/api\/admin\/affiliate-feed/.test(pathname)) return "community";
  if (/^\/api\/admin\/affiliate-marketing/.test(pathname)) return "marketing_kit";
  if (/^\/api\/admin\/affiliates/.test(pathname)) return "affiliates";
  if (/^\/api\/admin\/financial/.test(pathname)) return "financial";
  if (/^\/api\/admin\/fiscal/.test(pathname)) return "fiscal";
  if (/^\/api\/admin\/marketing-pixels/.test(pathname)) return "marketing_pixels";
  if (/^\/api\/admin\/notifications/.test(pathname)) return "notifications";
  if (/^\/api\/admin\/pricing/.test(pathname)) return "pricing";
  if (/^\/api\/admin\/push/.test(pathname)) return "push";
  if (/^\/api\/admin\/store-theme/.test(pathname)) return "store_theme";
  if (/^\/api\/products/.test(pathname)) return "products";
  if (/^\/api\/categories/.test(pathname)) return "categories";
  if (/^\/api\/orders/.test(pathname) || /\/orders\//.test(pathname)) return "orders";
  if (/^\/api\/customers/.test(pathname)) return "customers";
  if (/^\/api\/settings/.test(pathname)) return "settings";
  if (/^\/api\/shipping/.test(pathname)) return "shipping";
  return "admin";
}

function getActionVerb(method, pathname) {
  const lastSegments = pathname.split("/").filter(Boolean).slice(-3).join("/").toLowerCase();

  const specialActions = [
    ["unpin", "unpin"],
    ["unban", "unban"],
    ["approve", "approve"],
    ["reject", "reject"],
    ["ban", "ban"],
    ["payout", "payout"],
    ["pay", "pay"],
    ["sync", "sync"],
    ["apply", "apply"],
    ["process", "process"],
    ["publish", "publish"],
    ["hide", "hide"],
    ["pin", "pin"],
    ["cleanup", "cleanup"],
    ["upload", "upload"],
    ["test", "test"],
  ];

  for (const [needle, action] of specialActions) {
    if (lastSegments.includes(needle)) return action;
  }

  if (method === "DELETE") return "delete";
  if (method === "PUT" || method === "PATCH") return "update";
  if (method === "POST") {
    const segments = pathname.split("/").filter(Boolean);
    const last = segments.at(-1) || "";
    const looksLikeId = /^[0-9a-f-]{20,}$/i.test(last) || /^\d+$/.test(last);
    return looksLikeId ? "execute" : "create";
  }

  return "execute";
}

function getEntityId(pathname, body) {
  const segments = pathname.split("/").filter(Boolean);
  const ignored = new Set([
    "api", "admin", "products", "categories", "orders", "customers", "settings", "shipping",
    "affiliates", "financial", "fiscal", "pricing", "notifications", "push", "store-theme",
    "marketing-pixels", "affiliate-feed", "affiliate-marketing", "access-requests", "posts", "stories",
    "approve", "reject", "ban", "unban", "delete", "apply", "sync", "pin", "unpin", "hide",
    "cleanup-expired", "process-paid", "status", "read", "read-all", "payouts", "levels", "palettes",
    "assets", "messages", "trainings", "uploads", "categories", "accounts-payable", "accounts-receivable",
  ]);

  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index];
    if (!ignored.has(segment.toLowerCase())) return truncateText(segment, 120);
  }

  const candidate = body?.id || body?.product_id || body?.order_id || body?.affiliate_id || body?.entity_id;
  return candidate ? truncateText(candidate, 120) : null;
}

function getEntityType(moduleName, pathname) {
  if (moduleName === "community") return pathname.includes("/stories/") ? "story" : "post";
  if (moduleName === "admin_access") return "admin_access_request";
  if (moduleName === "marketing_kit") {
    if (pathname.includes("/assets")) return "marketing_asset";
    if (pathname.includes("/messages")) return "marketing_message";
    if (pathname.includes("/trainings")) return "training";
  }
  if (moduleName === "financial") {
    if (pathname.includes("accounts-payable")) return "account_payable";
    if (pathname.includes("accounts-receivable")) return "account_receivable";
    if (pathname.includes("categories")) return "financial_category";
  }
  if (moduleName === "products") return "product";
  if (moduleName === "categories") return "category";
  if (moduleName === "orders") return "order";
  if (moduleName === "customers") return "customer";
  if (moduleName === "affiliates") return "affiliate";
  if (moduleName === "pricing") return "product_pricing";
  if (moduleName === "settings" || moduleName === "store_theme") return "store_settings";
  return moduleName;
}

function buildActionCode(moduleName, actionVerb, pathname) {
  const resource = getEntityType(moduleName, pathname);
  return `${resource}_${actionVerb}`;
}

function buildDescription(actor, moduleName, actionVerb, entityId, status) {
  const actorName = actor.full_name || actor.email || "Administrador";
  const actionLabel = ACTION_LABELS[actionVerb] || ACTION_LABELS.execute;
  const moduleLabel = MODULE_LABELS[moduleName] || moduleName;
  const entity = entityId ? ` (${entityId})` : "";
  const result = status === "failure" ? " A operação falhou." : "";

  return `${actorName} ${actionLabel} em ${moduleLabel}${entity}.${result}`;
}

function getSafeQuery(req) {
  const query = req?.query;
  if (!query || typeof query !== "object" || !Object.keys(query).length) return null;
  return sanitizeValue(query);
}

function scheduleAudit(payload) {
  setImmediate(() => {
    recordAuditLog(payload).catch((error) => {
      console.error("[AUTOMATIC_ADMIN_AUDIT_ERROR]", {
        action: payload?.action,
        module: payload?.module,
        message: error?.message || String(error),
      });
    });
  });
}

export function captureAdminMutationAudit(req, res, next) {
  const method = String(req.method || "GET").toUpperCase();
  const pathname = normalizePath(req);

  if (!MUTATION_METHODS.has(method) || !isAuditedPath(pathname) || shouldIgnorePath(pathname)) {
    return next();
  }

  const startedAt = Date.now();
  let recorded = false;

  res.on("finish", () => {
    if (recorded) return;
    recorded = true;

    const actor = normalizeActor(req);
    if (!actor) return;

    const moduleName = getModule(pathname);
    const actionVerb = getActionVerb(method, pathname);
    const entityId = getEntityId(pathname, req.body);
    const status = res.statusCode >= 200 && res.statusCode < 400 ? "success" : "failure";
    const changedFields = getChangedFields(req.body);

    scheduleAudit({
      req,
      actor,
      action: buildActionCode(moduleName, actionVerb, pathname),
      module: moduleName,
      entityType: getEntityType(moduleName, pathname),
      entityId,
      description: buildDescription(actor, moduleName, actionVerb, entityId, status),
      newValues: changedFields.length
        ? {
            changed_fields: changedFields,
            values: sanitizeValue(req.body),
          }
        : null,
      metadata: {
        automatic_capture: true,
        method,
        path: pathname,
        query: getSafeQuery(req),
        response_status: res.statusCode,
        duration_ms: Date.now() - startedAt,
      },
      status,
    });
  });

  return next();
}
