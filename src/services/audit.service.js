import { isIP } from "node:net";

import {
  deleteAuditLogById,
  findAuditLogById,
  getAuditFilterOptions,
  getAuditSummary,
  insertAuditLog,
  isAuditTableMissing,
  listAuditLogs,
} from "../repositories/audit-logs.repository.js";

const SENSITIVE_KEY_PATTERN =
  /(password|senha|token|authorization|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|cvv|card[_-]?number|numero[_-]?cartao|cpf|document|signature)/i;

function truncateAuditText(value, maxLength = 500) {
  const text = String(value ?? "");
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}…`;
}

function redactSensitive(value, depth = 0) {
  if (depth > 5) return "[limite de profundidade]";
  if (Array.isArray(value)) {
    return value.slice(0, 30).map((item) => redactSensitive(item, depth + 1));
  }
  if (typeof value === "string") return truncateAuditText(value);
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value).slice(0, 80).map(([key, item]) => [
      key,
      SENSITIVE_KEY_PATTERN.test(String(key)) ? "[protegido]" : redactSensitive(item, depth + 1),
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

export async function deleteAuditLog({ id } = {}) {
  const normalizedId = String(id || "").trim();

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalizedId)) {
    const error = new Error("Registro de auditoria inválido.");
    error.statusCode = 400;
    throw error;
  }

  try {
    const existing = await findAuditLogById(normalizedId);

    if (!existing) {
      const error = new Error("Registro de auditoria não encontrado.");
      error.statusCode = 404;
      throw error;
    }

    await deleteAuditLogById(normalizedId);
    return { id: normalizedId };
  } catch (error) {
    if (isAuditTableMissing(error)) {
      const setupError = new Error("A tabela de auditoria ainda não foi instalada.");
      setupError.statusCode = 409;
      throw setupError;
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
