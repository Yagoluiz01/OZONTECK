import { env } from "../config/env.js";
import { sendAiMessage } from "../services/AI/ai.service.js";
import { runAgent } from "../services/AI/agent/index.js";


const MAX_HISTORY = 20;

function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];

  return history
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

    const userMessage = String(req.body?.message || "").trim();

    if (!userMessage) {
      return res.status(400).json({
        success: false,
        message: "Mensagem não pode estar vazia.",
      });
    }

    if (userMessage.length > 4000) {
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

    // Se a intenção for criar/adicione produto, encaminha para o agent.
    // Mantém simples e tolerante, porque o front pode mandar textos sem padronização.
    const wantsProductsCreate = (
      /crie|criar|adicione|adicionar/i.test(userMessage) ||
      /\b(novo|novos)\b/i.test(lowerMessage) ||
      /produtos?|produto/i.test(lowerMessage) ||
      /\b(teste)\b/i.test(lowerMessage)
    );


    if (wantsProductsCreate) {
      const authorization = String(req.headers?.authorization || "").trim();

      const result = await runAgent({
        message: userMessage,
        contexts: [],
        history,
        user: req.admin || req.body?.user || { id: null, role: "unknown" },
        permissions:
          req.permissions || req.body?.permissions || [],
        requestId: req.headers?.["x-request-id"] || null,
        authToken: authorization || null,
      });


      return res.status(200).json(result);
    }

    const reply = await sendAiMessage(
      {
        message: userMessage,
        history,
      },
      req.admin
    );

    return res.status(200).json({
      success: true,
      reply,
    });


  } catch (error) {
    console.error("[ADMIN_AI_CHAT_ERROR]", error);

    return res.status(500).json({
      success: false,
      message: "Erro interno ao processar a mensagem.",
    });
  }
}