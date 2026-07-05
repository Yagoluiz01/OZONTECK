export function resolveAction(message) {
  if (!message) return null;

  const text = String(message).toLowerCase();

  // SECURITY: reduzir superfície de ataque
  // -> não faz matching amplo; usa allowlist de módulos esperados.
  const ALLOWED = new Set([
    "products",
    "customers",
    "orders",
    "financial",
    "affiliates",
    "leads",
    "dashboard",
  ]);

  // Produto/Estoque
  if (text.includes("produto") || text.includes("produtos") || text.includes("estoque")) {
    return ALLOWED.has("products") ? "products" : null;
  }

  // Cliente
  if (text.includes("cliente") || text.includes("clientes")) {
    return ALLOWED.has("customers") ? "customers" : null;
  }

  // Pedidos
  if (text.includes("pedido") || text.includes("pedidos")) {
    return ALLOWED.has("orders") ? "orders" : null;
  }

  // Financeiro
  if (text.includes("financeiro") || text.includes("caixa") || text.includes("faturamento")) {
    return ALLOWED.has("financial") ? "financial" : null;
  }

  // Afiliados
  if (text.includes("afiliado") || text.includes("afiliados")) {
    return ALLOWED.has("affiliates") ? "affiliates" : null;
  }

  // Leads
  if (text.includes("lead") || text.includes("leads")) {
    return ALLOWED.has("leads") ? "leads" : null;
  }

  // Dashboard
  if (text.includes("dashboard") || text.includes("painel") || text.includes("painéis")) {
    return ALLOWED.has("dashboard") ? "dashboard" : null;
  }

  return null;
}

