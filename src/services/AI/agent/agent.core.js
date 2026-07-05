import { buildAiContext } from "../context/index.js";
import { modulePermissions } from "../permissions/modules.permissions.js";
import { filterContextsByPermission } from "../permissions/permissions.engine.js";
import { sendAiMessage } from "../ai.service.js";
import { generateReportsAction } from "./agent.reports.js";
import { aiTools } from "../tools/index.js";



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

      // Integração mínima para parar a resposta repetida:
      // quando o usuário pedir “adicione/crie produto”, executamos um CREATE de um produto teste.
      // Segurança: o tool `products_write` tem allowlist create/update/delete e também revalida permissão.
      const wantsCreate = /\b(adi(cione|ção)r|criar|crie|nova|novo)\b/i.test(lower) || lower.includes("teste");

      if (!wantsCreate) {
        agentReply = {
          success: true,
          reply:
            "Permissão confirmada para produtos. Para este teste, envie explicitamente “adicione/crie produto”.",
        };
        audit.endedAt = new Date().toISOString();
        audit.durationMs = Date.now() - startedAt;
        return { ...agentReply, audit };
      }

      const skuMatch = message.match(/\b([A-Z0-9\-]{5,})\b/i);
      const priceMatch = message.match(/R\$\s*([0-9]+([\.,][0-9]{1,2})?)/i);
      const qtyMatch = message.match(/\b(qtd|quantidade|estoque)\s*:?\s*(\d+)/i);

      const sku = (skuMatch && skuMatch[1]) ? String(skuMatch[1]).toUpperCase() : "TESTE-IA-001";
      const price = priceMatch && priceMatch[1] ? Number(priceMatch[1].replace(',', '.')) : 10;
      const stock_quantity = qtyMatch && qtyMatch[2] ? Number(qtyMatch[2]) : 10;

      const actor = user ? { id: user.id, role: user.role } : { id: null, role: null };

      const operation = {
        type: "create",
        payload: {
          name: "Produto teste IA",
          sku,
          price,
          stock_quantity,
          status: "draft",
          description: "Criado via AI (teste de integração).",
        },
        // tool revalida permissão e usa auth token opcional.
        // Mantemos vazio para permitir que o backend use validação do requireAuth no próprio endpoint.
        authToken: "",
      };

      audit.toolCalls.push({
        name: "products.write",
        status: "ok",
        reason: "create_product_test_payload",
      });

      const res = await aiTools.products_write({
        permissions,
        reqMeta: { requestId },
        actor,
        operation,
      });

      agentReply = {
        success: true,
        reply: "Produto teste criado com sucesso.",
        product: res?.product || res,
        operation,
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

