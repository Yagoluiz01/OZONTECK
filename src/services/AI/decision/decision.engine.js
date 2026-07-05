
export function decisionEngine(knowledge, message = "") {
  const signals = [];

  // Automations base (estoque/caixa)
  const lowStock = knowledge.products?.lowStock ?? [];
  const outStock = knowledge.products?.outOfStock ?? [];

  if (lowStock.length > 0) {
    signals.push({
      type: "LOW_STOCK",
      data: lowStock,
    });
  }

  if (outStock.length > 0) {
    signals.push({
      type: "OUT_OF_STOCK",
      data: outStock,
    });
  }

  const revenue = knowledge.financial?.summary?.revenue ?? 0;
  const expenses = knowledge.financial?.summary?.expenses ?? 0;

  if (revenue < expenses) {
    signals.push({
      type: "NEGATIVE_CASHFLOW",
      data: { revenue, expenses },
    });
  }

  // Perguntas de negócio => sinais para actions de leitura
  const lower = String(message || "").toLowerCase();
  const wantsVendasMes = lower.includes("vendas") && (lower.includes("mês") || lower.includes("mes"));
  const wantsFaturamos = lower.includes("fatur") || lower.includes("faturamos") || lower.includes("receita");
  const wantsPedidos = lower.includes("quant") && lower.includes("pedido");
  const wantsLucro = lower.includes("lucro");

  if (wantsVendasMes || wantsFaturamos || wantsLucro) {
    signals.push({
      type: "FINANCIAL_SUMMARY",
      data: {},
    });
  }

  if (wantsPedidos) {
    signals.push({
      type: "ORDERS_SUMMARY",
      data: {},
    });
  }

  return signals;
}
