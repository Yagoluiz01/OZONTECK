import { deepseek } from "../services/deepseek.service.js";
import { env } from "../config/env.js";
const MAX_HISTORY = 20;

function getSystemPrompt(admin) {
  const name = admin?.fullName || admin?.email || "Administrador";
  const role = admin?.role || "admin";

  return `
Você é o assistente administrativo inteligente da OZONTECK.

Você auxilia o administrador:

Nome: ${name}
Função: ${role}

Você possui acesso aos dados enviados pelo backend desta conversa.

IMPORTANTE:

Sempre considere os dados recebidos no prompt do sistema como dados reais do sistema.

Quando houver informações de:
- pedidos
- clientes
- produtos
- afiliados
- estoque
- faturamento
- relatórios

Você deve utilizar esses dados para responder.

Nunca diga que não possui acesso aos dados se eles foram enviados pelo backend.

Nunca invente dados inexistentes.

Se uma informação não estiver presente nos dados recebidos, informe apenas que ela não foi encontrada.

Responda sempre em português do Brasil.

Seja objetivo, preciso e útil.
`;
}

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
  try {
    const apiKey = env.deepseekApiKey;

    if (!apiKey) {
      return res.status(503).json({
        success: false,
        message:
          "Assistente de IA não configurado. Adicione DEEPSEEK_API_KEY nas variáveis de ambiente.",
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
      {
        role: "user",
        content: userMessage,
      },
    ];



const response = await fetch(
  `${env.supabaseUrl}/rest/v1/orders?select=*`,
  {
    method: "GET",
    headers: {
      apikey: env.supabaseServiceRoleKey,
      Authorization: `Bearer ${env.supabaseServiceRoleKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
  }
);

const orders = await response.json();

const systemData = `
DADOS REAIS DA OZONTECK

PEDIDOS:
${JSON.stringify(orders, null, 2)}
`;

console.log("=================================");
console.log("TESTE IA -> ORDERS");
console.log("STATUS:", response.status);
console.log("TOTAL ORDERS:", Array.isArray(orders) ? orders.length : 0);
console.log("DADOS:", orders);
console.log("=================================");
console.log("SYSTEM DATA:");
console.log(systemData);

    const completion = await deepseek.chat.completions.create({
      model: "deepseek-chat",
      temperature: 0,
      max_tokens: 300,
     messages: [
  {
    role: "system",
    content: getSystemPrompt(req.admin) + "\n\n" + systemData,
  },
  ...messages,
],
    });

    const reply =
      completion?.choices?.[0]?.message?.content?.trim() ||
      "Sem resposta.";

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