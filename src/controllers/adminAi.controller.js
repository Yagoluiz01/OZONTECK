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

ALGUNS_PRODUTOS:
${JSON.stringify(products.slice(0, 20), null, 2)}
`;
}