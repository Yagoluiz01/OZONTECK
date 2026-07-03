import { dispatchAction } from "./actions/dispatcher.js";

export async function actionRouter(signals, knowledge) {
  const results = [];

  for (const signal of signals) {
    switch (signal.type) {

      case "critical_stock":
        results.push(
          await dispatchAction("recommendRestock", { knowledge })
        );
        break;

      case "negative_cashflow":
        results.push({
          alert: "Fluxo de caixa negativo detectado",
          severity: signal.severity,
          value: signal.value,
        });
        break;

      case "order_backlog":
        results.push(
          await dispatchAction("analyzeOrders", { knowledge })
        );
        break;

      case "customer_churn_risk":
        results.push(
          await dispatchAction("analyzeCustomers", { knowledge })
        );
        break;
    }
  }

  return results;
}