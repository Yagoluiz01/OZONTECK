import { buildAiContext } from "../context/index.js";
import { modulePermissions } from "../permissions/modules.permissions.js";
import { filterContextsByPermission } from "../permissions/permissions.engine.js";
import { sendAiMessage } from "../ai.service.js";
import { generateReportsAction } from "./agent.reports.js";


function safeJsonParse(value) {
  try {
    if (typeof value === "string") return JSON.parse(value);
    return value;
  } catch {
    return null;
  }
}

function normalizeContexts(contexts) {
  if (!Array.isArray(contexts)) return [];
  return contexts.filter((c) => typeof c === "string").map((c) => c.trim());
}

function sanitizeForAudit(value) {
  // máximo cuidado: remove tokens sensíveis comuns
  const s = typeof value === "string" ? value : JSON.stringify(value);
  if (!s) return value;

  const scrub = s
    .replace(/api[_-]?key\s*[:=]\s*[^\s"']+/gi, "api_key:[REDACTED]")
    .replace(/bearer\s+[^\s"']+/gi, "bearer [REDACTED]")
    .replace(/token\s*[:=]\s*[^\s"']+/gi, "token:[REDACTED]");

  return scrub;
}

export async function runAgent({
  message,
  user,
  history = [],
  contexts = [],
  permissions = [],
  requestId,
} = {}) {
  // hardening: evita erros em cenários onde caller manda undefined
  message = String(message || "");

  const startedAt = Date.now();


  const normalizedContexts = normalizeContexts(contexts);

  // 1) filtro de contexts por permissão do usuário (default deny)
  const allowedContexts = filterContextsByPermission(
    normalizedContexts,
    permissions
  );

  // 2) knowledge base (somente leitura)
  const baseContext = await buildAiContext();

  // 3) orquestração simples: relatório se o usuário pedir; caso contrário, responde
  const lower = String(message || "").toLowerCase();
  const wantsReport =
    lower.includes("relat") ||
    lower.includes("report") ||
    lower.includes("excel") ||
    lower.includes("pdf");

  const wantsProducts = lower.includes("produto") || lower.includes("produtos");

  const audit = {
    requestId: requestId || null,
    startedAt: new Date(startedAt).toISOString(),
    endedAt: null,
    ok: true,
    message: sanitizeForAudit(message),
    user: user ? { id: user.id, role: user.role } : null,
    permissions,
    allowedContexts,
    toolCalls: [],
  };

  try {
    let agentReply = null;
    let toolResult = null;

    if (wantsReport && wantsProducts) {
      const { format } = await generateReportsAction({ message });
      const permKey = modulePermissions.reports || "reports.view";

      // segurança: se não tiver permissão de relatórios, bloqueia
      const hasPermission = permissions.includes(permKey) || permissions.includes("admin");
      if (!hasPermission) {
        audit.ok = false;
        audit.toolCalls.push({
          name: "report.generate",
          status: "blocked",
          reason: "missing_permission",
        });

        return {
          success: false,
          error: true,
          message: "Sem permissão para gerar relatórios.",
          audit,
        };
      }

      toolResult = await generateReportsAction({ message, format });
      audit.toolCalls.push({
        name: "report.generate",
        status: "ok",
        result: toolResult ? { keys: Object.keys(toolResult) } : null,
      });

      agentReply = {
        success: true,
        reply: "Relatório gerado com sucesso.",
        tool: "report.generate",
        ...toolResult,
      };
    } else if (wantsProducts) {
      // Hard-deny: operações de escrita em produtos (create/update/delete) só
      // são permitidas com permissão explícita products.manage.
      const managePerm = modulePermissions.products_manage || "products.manage";
      const hasManagePermission = permissions.includes(managePerm) || permissions.includes("admin");

      if (!hasManagePermission) {
        audit.ok = false;
        audit.toolCalls.push({
          name: "products.write",
          status: "blocked",
          reason: "missing_permission",
          required: managePerm,
        });

        return {
          success: false,
          error: true,
          message: "Sem permissão para alterar produtos.",
          audit,
        };
      }

      // Observação: por enquanto o agent core só executa report/download.
      // Quando o pipeline de tools do CRUD estiver conectado, este bloco
      // será o ponto de autorização.
      agentReply = {
        success: true,
        reply:
          "Permissão confirmada para operações de produtos. Aguarde a integração completa do tool CRUD.",
      };
    } else {
      // responder sem executar ações
      const promptContext = {
        base: baseContext,
        allowedContexts: allowedContexts,
      };

      const replyText = await sendAiMessage(
        { message, history, promptContext, user }
      );





      agentReply = {
        success: true,
        reply: replyText,
      };
    }

    audit.endedAt = new Date().toISOString();
    audit.durationMs = Date.now() - startedAt;

    return {
      ...agentReply,
      audit,
    };
  } catch (error) {
    audit.ok = false;
    audit.endedAt = new Date().toISOString();
    audit.durationMs = Date.now() - startedAt;
    audit.error = { message: error?.message };

    return {
      success: false,
      error: true,
      message: error?.message || "Erro ao executar agente.",
      audit,
    };
  }
}

