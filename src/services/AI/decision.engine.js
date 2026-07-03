export function decisionEngine(knowledge) {
  const signals = [];

  // 📦 Estoque crítico
  const outOfStock = knowledge.products?.outOfStock?.length ?? 0;

  if (outOfStock > 0) {
    signals.push({
      type: "critical_stock",
      severity: "high",
      value: outOfStock,
    });
  }

  // 💰 Fluxo de caixa
  const revenue = knowledge.financial?.summary?.revenue ?? 0;
  const expenses = knowledge.financial?.summary?.expenses ?? 0;

  if (revenue - expenses < 0) {
    signals.push({
      type: "negative_cashflow",
      severity: "high",
      value: revenue - expenses,
    });
  }

  // 📦 Pedidos atrasados
  const pendingOrders = knowledge.orders?.summary?.pending ?? 0;

  if (pendingOrders > 10) {
    signals.push({
      type: "order_backlog",
      severity: "medium",
      value: pendingOrders,
    });
  }

  // 👥 Clientes inativos
  const inactiveCustomers = knowledge.customers?.summary?.inactive ?? 0;

  if (inactiveCustomers > 50) {
    signals.push({
      type: "customer_churn_risk",
      severity: "medium",
      value: inactiveCustomers,
    });
  }

  return signals;
}