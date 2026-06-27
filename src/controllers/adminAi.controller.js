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
      console.error(`Erro ao buscar tabela ${table}:`, response.status);
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


  const activeProducts = products.filter(
  (p) => p.status === "active"
);

const inactiveProducts = products.filter(
  (p) => p.status === "inactive"
);

const draftProducts = products.filter(
  (p) => p.status === "draft"
);

const lowStockProducts = products.filter((p) => {
  const stock = Number(p.stock_quantity || 0);
  return stock > 0 && stock <= 5;
});

const outOfStockProducts = products.filter(
  (p) => Number(p.stock_quantity || 0) === 0
);

  console.log("=================================");
  console.log("DADOS DA IA");
  console.log("ORDERS:", orders.length);
  console.log("CUSTOMERS:", customers.length);
  console.log("PRODUCTS:", products.length);
  console.log("=================================");

  return `
DADOS REAIS DA OZONTECK

RESUMO:

TOTAL_PEDIDOS: ${orders.length}
TOTAL_CLIENTES: ${customers.length}

TOTAL_PRODUTOS: ${products.length}
PRODUTOS_ATIVOS: ${activeProducts.length}
PRODUTOS_INATIVOS: ${inactiveProducts.length}
PRODUTOS_DRAFT: ${draftProducts.length}

PRODUTOS_ESTOQUE_BAIXO: ${lowStockProducts.length}
PRODUTOS_SEM_ESTOQUE: ${outOfStockProducts.length}

ULTIMOS_PEDIDOS:
${JSON.stringify(orders.slice(0, 10), null, 2)}

ULTIMOS_CLIENTES:
${JSON.stringify(customers.slice(0, 10), null, 2)}


ESTOQUE_BAIXO:
${JSON.stringify(
  lowStockProducts.map((p) => ({
    name: p.name,
    stock: p.stock_quantity,
  })),
  null,
  2
)}

SEM_ESTOQUE:
${JSON.stringify(
  outOfStockProducts.map((p) => ({
    name: p.name,
    stock: p.stock_quantity,
  })),
  null,
  2
)}

PRODUTOS:
${JSON.stringify(products, null, 2)}
`;
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



    const lowerMessage = userMessage.toLowerCase();

    console.log("=================================");
    console.log("MENSAGEM RECEBIDA:", userMessage);
    console.log("=================================");

const wantsExcel =
  lowerMessage.includes("excel") ||
  lowerMessage.includes("xlsx") ||
  lowerMessage.includes("planilha");

const wantsPdf =
  lowerMessage.includes("pdf");

const wantsProductsReport =
  lowerMessage.includes("produto");


const wantsCustomersReport =
  lowerMessage.includes("cliente");

const wantsOrdersReport =
  lowerMessage.includes("pedido");


  console.log("wantsExcel:", wantsExcel);
console.log("wantsProductsReport:", wantsProductsReport);

    const isReportRequest =
  userMessage.toLowerCase().includes("relatório") ||
  userMessage.toLowerCase().includes("relatorio");

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

    const systemData = await buildSystemData();


    let reportInstructions = "";

if (isReportRequest) {
  reportInstructions = `
O usuário está solicitando um relatório.

Retorne o relatório em formato estruturado:

TÍTULO:
RESUMO:
INDICADORES:
CONCLUSÃO:

Use exclusivamente os dados enviados pelo backend.

NUNCA conte produtos manualmente.

NUNCA calcule indicadores por conta própria.

Utilize exatamente os valores:

TOTAL_PRODUTOS
PRODUTOS_ATIVOS
PRODUTOS_INATIVOS
PRODUTOS_DRAFT
PRODUTOS_ESTOQUE_BAIXO
PRODUTOS_SEM_ESTOQUE

Se esses valores estiverem presentes, utilize-os sem recalcular.
`;
}



if (wantsExcel && wantsProductsReport) {

  console.log("ENTROU NO DOWNLOAD REPORT");

  return res.status(200).json({
    success: true,
    action: "download_report",
    reportType: "products",
    format: "excel",
    downloadUrl: "/api/reports/products/excel"
  });
}



if (wantsPdf && wantsProductsReport) {
  return res.json({
    action: "download_report",
    downloadUrl: "/api/reports/products/pdf",
  });
}


    const completion = await deepseek.chat.completions.create({
      model: "deepseek-chat",
      temperature: 0,
      max_tokens: 500,
      messages: [
        {
          role: "system",
          content:
  getSystemPrompt(req.admin) +
  "\n\n" +
  systemData +
  "\n\n" +
  reportInstructions,
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
      stack: error?.stack,
    });

    return res.status(500).json({
      success: false,
      message: "Erro interno ao processar sua mensagem.",
    });
  }
}