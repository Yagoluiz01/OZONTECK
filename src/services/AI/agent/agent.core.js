import { buildAiContext } from "../context/index.js";
import { modulePermissions } from "../permissions/modules.permissions.js";
import { filterContextsByPermission } from "../permissions/permissions.engine.js";
import { sendAiMessage } from "../ai.service.js";
import { generateReportsAction } from "./agent.reports.js";
// NOTE: mantém arquitetura existente, mas evita execução direta fora do pipeline.

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
  authToken = null,
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

  // Detecção robusta (evita fallback quando o usuário pede create/CRUD)
  // - aceita 'adi(cione|ção)r', 'criar', 'crie', 'novo', e também a palavra 'teste'
  // - com bordas de palavra para não pegar 'produto' como 'novo'
  const wantsCreate = /\b(adi(cione|ção)|criar|crie|novo|novos)\b/i.test(lower) || lower.includes("teste");


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
          reply: "Sem permissão para gerar relatórios.",
          data: {},
          actions: [],
          metadata: {},
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
        data: { ...(toolResult || {}) },
        actions: [],
        metadata: { tool: "report.generate" },
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
          reply: "Sem permissão para alterar produtos.",
          data: {},
          actions: [],
          metadata: {},
          audit,
        };
      }

      // Integração mínima para parar a resposta repetida:
      // quando o usuário pedir “adicione/crie produto”, executamos um CREATE de um produto teste.
      // Segurança: o tool `products_write` tem allowlist create/update/delete e também revalida permissão.
      const wantsCreate = /\b(adi(cione|ção)r|criar|crie|nova|novo)\b/i.test(lower) || lower.includes("teste");

      if (!wantsCreate) {
      agentReply = {
        success: true,
        reply:
          "Permissão confirmada para produtos. Para executar escrita, envie explicitamente “Adicionar produto” (com dados).",
        data: {},
        actions: [],
        metadata: {},
      };

      audit.endedAt = new Date().toISOString();
      audit.durationMs = Date.now() - startedAt;

      return {
        ...agentReply,
        audit,
        data: {
          ...(agentReply.data || {}),
          allowedContexts,
        },
      };
      }

      // Mantém compatibilidade: execução de products_write permanece no tool,
      // mas não vamos forçar payload de teste aqui; a escrita real deve vir do dispatcher.
      // Se o cliente ainda enviar sem dados estruturados, devolvemos instrução clara.
      agentReply = {
        success: true,
        reply:
          "Para criar/atualizar produto via AI, envie dados suficientes (nome, SKU e preço/estoque).",
        data: {},
        actions: [],
        metadata: {
          hint: "Exemplo: Adicionar produto nome=Perfume X sku=ABC123 price=49,90 estoque=10",
        },
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

      // Garantir formato esperado: reply SEMPRE string
      const replyString =
        typeof replyText === "string"
          ? replyText
          : replyText?.reply || replyText?.message || "";

      agentReply = {
        success: true,
        reply: String(replyString || "Sem resposta."),
        data: {},
        actions: [],
        metadata: {},
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
      reply: error?.message || "Erro ao executar agente.",
      data: {},
      actions: [],
      metadata: {},
      audit,
    };
  }
}

