import { env } from "../config/env.js";
import { deepseek } from "../services/deepseek.service.js";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 1024;
const MAX_HISTORY = 20;

function getSystemPrompt(admin) {
  const name = admin?.fullName || admin?.email || "Administrador";
  const role = admin?.role || "admin";

  return `Você é um assistente de negócios integrado ao painel administrativo da Ozonteck. Você ajuda o administrador "${name}" (função: ${role}) a analisar dados, gerar relatórios, interpretar métricas e automatizar tarefas do dia a dia.

Você tem conhecimento sobre:
- Pedidos, clientes, produtos e estoque
- Métricas financeiras, DRE, frete e precificação
- Afiliados, cupons, banners e configurações da loja
- Alertas operacionais e ações recomendadas

Responda sempre em português do Brasil. Seja direto, objetivo e prático. Quando sugerir ações, indique o caminho no painel (ex: "vá em Pedidos > Filtrar por pendente"). Formate respostas longas com marcadores para facilitar a leitura.`;
}

function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];

  return history
    .filter((msg) => {
      const role = String(msg?.role || "");
      const content = String(msg?.content || "").trim();
      return (role === "user" || role === "assistant") && content.length > 0;
    })
    .slice(-MAX_HISTORY)
    .map((msg) => ({
      role: msg.role,
      content: String(msg.content).trim(),
    }));
}

export async function aiChat(req, res) {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;

    if (!apiKey) {
      return res.status(503).json({
        success: false,
        message: "Assistente de IA não configurado. Adicione ANTHROPIC_API_KEY nas variáveis de ambiente.",
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
        message: "Mensagem muito longa. Limite de 4000 caracteres.",
      });
    }

    const history = sanitizeHistory(req.body?.history);

    const messages = [
      ...history,
      { role: "user", content: userMessage },
    ];


    const completion = await deepseek.chat.completions.create({
  model: "deepseek-chat",
  messages: [
    {
      role: "system",
      content: getSystemPrompt(req.admin),
    },
    ...messages,
  ],
  max_tokens: 200,
});

console.log(
  "[DEEPSEEK_TEST]",
  completion?.choices?.[0]?.message?.content
);

return res.status(200).json({
  success: true,
  reply:
    completion?.choices?.[0]?.message?.content ||
    "Sem resposta",
});

    const response = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: MAX_TOKENS,
        system: getSystemPrompt(req.admin),
        messages,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("[ADMIN_AI_ANTHROPIC_ERROR]", {
        status: response.status,
        body: errorText.slice(0, 300),
      });

      if (response.status === 401) {
        return res.status(503).json({
          success: false,
          message: "Chave de API inválida. Verifique ANTHROPIC_API_KEY.",
        });
      }

      if (response.status === 429) {
        return res.status(429).json({
          success: false,
          message: "Limite de requisições atingido. Tente novamente em alguns segundos.",
        });
      }

      return res.status(502).json({
        success: false,
        message: "Não foi possível conectar ao assistente de IA agora.",
      });
    }

    const data = await response.json();
    const reply = data?.content
      ?.filter((block) => block?.type === "text")
      ?.map((block) => block.text)
      ?.join("") || "";

    if (!reply) {
      return res.status(502).json({
        success: false,
        message: "O assistente retornou uma resposta vazia.",
      });
    }

    return res.status(200).json({
      success: true,
      reply,
    });
  } catch (error) {
    console.error("[ADMIN_AI_CHAT_ERROR]", {
      message: error?.message,
      name: error?.name,
    });

    return res.status(500).json({
      success: false,
      message: "Erro interno ao processar sua mensagem.",
    });
  }
}
