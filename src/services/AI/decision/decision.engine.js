
export function decisionEngine(knowledge) {
  const signals = [];

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

  return signals;
}