import { aiTools } from "../index.js";
import { formatError, formatResponse } from "../core/response.core.js";
import { modulePermissions } from "../permissions/modules.permissions.js";

function resolveToolName(intent) {
  // intenção -> tool (registry implícito via allowlist interna)
  const map = {
    "products.write": "products_write",
    "products.read": "products",
    "financial.read": "financial",
    "financial.summary": "financial",
    "orders.read": "orders",
    "orders.summary": "orders",
    "customers.read": "customers",
    "affiliates.read": "affiliates",
    "leads.read": "leads",
    "dashboard.summary": "dashboard",
    "reports.generate": "reports",
  };


  return map[intent] || intent;
}





function getRequiredPermissionsForTool(toolName) {
  // Permission Engine (ponta a ponta, sem exception)
  // Só valida o “família” do recurso.
  if (!toolName) return null;

  if (toolName === "products_write") {
    return modulePermissions.products_manage || "products.manage";
  }

  // Reads: default view (quando existir)
  if (toolName === "products") return modulePermissions.products;
  if (toolName === "financial") return modulePermissions.financial;
  if (toolName === "orders") return modulePermissions.orders;
  if (toolName === "customers") return modulePermissions.customers;
  if (toolName === "affiliates") return modulePermissions.affiliates;
  if (toolName === "leads") return modulePermissions.leads;
  if (toolName === "dashboard") return modulePermissions.dashboard;
  if (toolName === "reports") return modulePermissions.reports;

  return null;
}

function hasPermission({ userPermissions = [], required }) {
  if (!required) return true;
  if (!Array.isArray(userPermissions)) return false;
  if (userPermissions.includes("admin")) return true;
  return userPermissions.includes(required);
}

export async function dispatchAction({
  intent,
  tool,
  knowledge,
  message,
  args = {},
  userPermissions = [],
  executionMeta = {},
} = {}) {
  try {
    const resolvedTool = resolveToolName(intent || tool);
    const toolFn = aiTools[resolvedTool];
    if (!toolFn) {
      return formatError({
        message: "Tool não encontrada",
        reply: `Não foi possível executar a intenção: ${intent || tool || ""}`,
        metadata: {
          tool: resolvedTool,
          intent,
          status: "not_found",
          ...executionMeta,
        },
      });
    }

    const required = getRequiredPermissionsForTool(resolvedTool);
    const ok = hasPermission({ userPermissions, required });
    if (!ok) {
      return formatError({
        reply: "Sem permissão para executar esta ação.",
        metadata: {
          tool: resolvedTool,
          intent,
          status: "permission_denied",
          required,
          ...executionMeta,
        },
      });
    }

    const result = await toolFn({
      knowledge,
      message,
      args,
      permissions: userPermissions,
      executionMeta,
    });

    return formatResponse({
      success: true,
      reply: "Ação executada com sucesso.",
      data: result && typeof result === "object" ? result : {},
      actions: [],
      metadata: {
        tool: resolvedTool,
        intent,
        status: "ok",
        ...executionMeta,
      },
    });
  } catch (error) {
    return formatError({
      message: error?.message,
      reply: "Falha ao executar ação.",
      metadata: {
        tool: tool,
        intent,
        status: "error",
        error: error?.message || String(error),
        ...executionMeta,
      },
    });
  }
}

