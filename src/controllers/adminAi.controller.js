import { env } from "../config/env.js";
import { sendAiMessage } from "../services/AI/ai.service.js";
import { runAgent } from "../services/AI/agent/index.js";
import { applyAiSecurityLayer } from "../services/AI/security/aiSecurityLayer.js";
import { enforceTenantGuard } from "../services/AI/security/aiTenantGuard.js";
import { runOrchestrator } from "../services/AI/orchestrator/index.js";



const MAX_HISTORY = 20;
const MAX_MESSAGE_LENGTH = 4000;
const MAX_HISTORY_ITEMS = 50;
const MAX_PAYLOAD_CHARS = 25000;

function sanitizeTextInput(value) {
  return String(value || "")
    .replace(/\0/g, "")
    .trim();
}

function estimatePayloadSize(value) {
  try {
    return JSON.stringify(value || {}).length;
  } catch {
    return MAX_PAYLOAD_CHARS + 1;
  }
}

function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];

  return history
    .slice(-MAX_HISTORY_ITEMS)
    .filter((msg) => {
      const role = String(msg?.role || "");
      const content = String(msg?.content || "").trim();

      return (
        (role === "user" || role === "assistant") &&
        content.length > 0
      );
    })
    .slice(-MAX_HISTORY)
    .map((msg) => ({
      role: msg.role,
      content: String(msg.content).trim(),
    }));
}

export async function aiChat(req, res) {
  // fallback chat (não executa tools/CRUD). 
  // Se o cliente estiver chamando este endpoint para criar/alterar entidades,
  // ele ficará somente em resposta textual.
  try {

    if (!env.deepseekApiKey) {
      return res.status(503).json({
        success: false,
        message:
          "Assistente de IA não configurado. Configure a variável DEEPSEEK_API_KEY.",
      });
    }

    const userMessage = sanitizeTextInput(req.body?.message);

    // Segurança/Governança (antes de qualquer processamento)
    const historyRaw = req.body?.history;
    const payloadSize = estimatePayloadSize(req.body);

    if (payloadSize > MAX_PAYLOAD_CHARS) {
      return res.status(413).json({
        success: false,
        message: "Payload muito grande para processamento.",
      });
    }

    console.info("[ADMIN_AI_ACCESS]", {
      adminId: req.admin?.id || null,
      role: req.admin?.role || null,
      path: req.originalUrl,
      method: req.method,
    });
    // Tenant guard antes de qualquer acesso a dados/LLM
    const tenantGuard = enforceTenantGuard({
      req,
      user: req.admin,
    });

    if (!tenantGuard?.ok) {
      return res.status(200).json(
        {
          success: false,
          reply: "Sem tenant válido para processar esta solicitação.",
          data: {},
          actions: [],
          metadata: {
            ...tenantGuard.metadata,
          },
        }
      );
    }

    const security = applyAiSecurityLayer({
      req,
      message: userMessage,
      history: historyRaw,
    });

    if (!security?.ok) {
      return res.status(200).json(security.response);
    }



    if (!userMessage) {
      return res.status(400).json({
        success: false,
        message: "Mensagem não pode estar vazia.",
      });
    }

    if (userMessage.length > MAX_MESSAGE_LENGTH) {
      return res.status(400).json({
        success: false,
        message: "Mensagem muito longa.",
      });
    }

    const history = sanitizeHistory(req.body?.history);

    const lowerMessage = userMessage.toLowerCase();

    const wantsExcel =
      lowerMessage.includes("excel") ||

      lowerMessage.includes("xlsx") ||
      lowerMessage.includes("planilha");

    const wantsPdf =
      lowerMessage.includes("pdf");

    const wantsProductsReport =
      lowerMessage.includes("produto");

    /*
     * Download de relatório Excel
     */

    if (wantsExcel && wantsProductsReport) {
      return res.status(200).json({
        success: true,
        action: "download_report",
        reportType: "products",
        format: "excel",
        downloadUrl: "/api/reports/products/excel",
      });
    }

    /*
     * Download de relatório PDF
     */

    if (wantsPdf && wantsProductsReport) {
      return res.status(200).json({
        success: true,
        action: "download_report",
        reportType: "products",
        format: "pdf",
        downloadUrl: "/api/reports/products/pdf",
      });
    }

    /*
     * IA
     */

    // Todo o pipeline (Planner + Orchestrator + Decision/Dispatch/Tools/Repositories)
    // passa a ser executado dentro do Orchestrator.

    // Inferência de contexts para garantir consultas ao banco quando o usuário pergunta métricas.
    // Mantém a arquitetura existente e apenas popula a lista de contexts.
    const lower = userMessage.toLowerCase();

    const contextsSet = new Set();

    if (/(venda|vendas|fatur|lucro|receita|despesa|financeiro|caixa|pagamentos)/i.test(lower)) {
      contextsSet.add("financial");
    }

    if (/(pedido|pedidos|quantos pedidos|status de pedido|atraso|entreg|shipping)/i.test(lower)) {
      contextsSet.add("orders");
    }

    if (/(produto|produtos|estoque|cat[aá]logo)/i.test(lower)) {
      contextsSet.add("products");
    }

    // fallback neutro para dashboard
    if (contextsSet.size === 0) contextsSet.add("dashboard");

    const contexts = Array.from(contextsSet);

    const orchestratorResult = await runOrchestrator({
      message: userMessage,
      contexts,
      user: req.admin || req.body?.user || null,
    });

    return res.status(200).json(orchestratorResult);






  } catch (error) {
    console.error("[ADMIN_AI_CHAT_ERROR]", error);

    return res.status(500).json({
      success: false,
      message: "Erro interno ao processar a mensagem.",
    });
  }
}