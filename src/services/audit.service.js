import { isIP } from "node:net";

import {
  getAuditFilterOptions,
  getAuditSummary,
  insertAuditLog,
  isAuditTableMissing,
  listAuditLogs,
} from "../repositories/audit-logs.repository.js";

const SENSITIVE_KEYS = new Set([
  "password",
  "confirm_password",
  "confirmPassword",
  "token",
  "access_token",
  "refresh_token",
  "authorization",
  "secret",
  "api_key",
  "apikey",
]);

function redactSensitive(value, depth = 0) {
  if (depth > 5) return "[limite de profundidade]";
  if (Array.isArray(value)) return value.map((item) => redactSensitive(item, depth + 1));
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      SENSITIVE_KEYS.has(String(key).toLowerCase()) ? "[protegido]" : redactSensitive(item, depth + 1),
    ])
  );
}

function getRequestIp(req) {
  const forwarded = String(req?.headers?.["x-forwarded-for"] || "")
    .split(",")[0]
    .trim();

  const candidate = forwarded || req?.ip || req?.socket?.remoteAddress || "";
  return isIP(candidate) ? candidate : null;
}

function buildEmptyResult(filters = {}) {
  const page = Math.max(1, Number(filters.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(filters.limit) || 25));

  return {
    logs: [],
    pagination: { page, limit, total: 0, pages: 1 },
    summary: { total: 0, last24h: 0, last7d: 0, failures: 0 },
    options: { modules: [], actions: [], admins: [] },
    setupRequired: true,
  };
}

export async function getAuditDashboard(filters = {}) {
  try {
    const [pageResult, summary, options] = await Promise.all([
      listAuditLogs(filters),
      getAuditSummary(),
      getAuditFilterOptions(),
    ]);

    return {
      ...pageResult,
      summary,
      options,
      setupRequired: false,
    };
  } catch (error) {
    if (isAuditTableMissing(error)) {
      return buildEmptyResult(filters);
    }

    throw error;
  }
}

export async function recordAuditLog({
  req,
  actor,
  action,
  module,
  entityType = null,
  entityId = null,
  description = null,
  oldValues = null,
  newValues = null,
  metadata = null,
  status = "success",
} = {}) {
  if (!action || !module) {
    throw new Error("Ação e módulo são obrigatórios para registrar auditoria.");
  }

  const admin = actor || req?.admin || {};

  const payload = {
    admin_id: admin.id || null,
    actor_user_id: admin.userId || null,
    actor_email: admin.email || null,
    actor_name: admin.full_name || admin.name || null,
    actor_role: admin.role || null,
    action: String(action),
    module: String(module),
    entity_type: entityType ? String(entityType) : null,
    entity_id: entityId ? String(entityId) : null,
    description: description ? String(description) : null,
    old_values: oldValues ? redactSensitive(oldValues) : null,
    new_values: newValues ? redactSensitive(newValues) : null,
    metadata: metadata ? redactSensitive(metadata) : {},
    ip_address: getRequestIp(req),
    user_agent: req?.headers?.["user-agent"] || null,
    request_id: req?.headers?.["x-request-id"] || null,
    status: status === "failure" ? "failure" : "success",
  };

  try {
    return await insertAuditLog(payload);
  } catch (error) {
    if (isAuditTableMissing(error)) {
      console.warn("[AUDIT_LOG_SKIPPED_TABLE_MISSING]", {
        action: payload.action,
        module: payload.module,
      });
      return null;
    }

    throw error;
  }
}
