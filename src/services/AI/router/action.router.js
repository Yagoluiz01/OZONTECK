export function resolveAction(message) {
  if (!message) return null;

  const text = message.toLowerCase();

  if (text.includes("produto") || text.includes("estoque")) {
    return "products";
  }

  if (text.includes("cliente")) {
    return "customers";
  }

  if (text.includes("pedido")) {
    return "orders";
  }

  if (text.includes("financeiro") || text.includes("caixa")) {
    return "financial";
  }

  if (text.includes("afiliado")) {
    return "affiliates";
  }

  if (text.includes("lead")) {
    return "leads";
  }

  if (text.includes("dashboard") || text.includes("painel")) {
    return "dashboard";
  }

  return null;
}