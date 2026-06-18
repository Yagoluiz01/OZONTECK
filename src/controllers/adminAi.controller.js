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

async function fetchTable(table, select = "*", limit = 1000) {
  try {
    const response = await fetch(
      `${env.supabaseUrl}/rest/v1/${table}?select=${select}&limit=${limit}`,
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

    if (!response.ok) {
      console.log(`Erro ao buscar tabela ${table}:`, response.status);
      return [];
    }

    return await response.json();
  } catch (error) {
    console.error(`Erro na tabela ${table}:`, error?.message);
    return [];
  }
}

async function buildSystemData() {
  const [orders, customers, products] = await Promise.all([
    fetchTable("orders"),
    fetchTable("customers"),
    fetchTable("products"),
  ]);

  console.log("ORDERS:", orders.length);
  console.log("CUSTOMERS:", customers.length);
  console.log("PRODUCTS:", products.length);

  return `
DADOS REAIS DA OZONTECK

RESUMO:

TOTAL_PEDIDOS: ${orders.length}
TOTAL_CLIENTES: ${customers.length}
TOTAL_PRODUTOS: ${products.length}

ULTIMOS_PEDIDOS:
${JSON.stringify(orders.slice(0, 10), null, 2)}

ULTIMOS_CLIENTES:
${JSON.stringify(customers.slice(0, 10), null, 2)}

PRODUTOS:
${JSON.stringify(products, null, 2)}
`;
}