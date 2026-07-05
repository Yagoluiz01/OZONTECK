import { productsActions } from "./products.actions.js";
import { financialActions } from "./financial.actions.js";
import { ordersActions } from "./orders.actions.js";

export async function executeActions(signals = [], knowledge) {
  const results = [];

  for (const signal of signals) {
    switch (signal.type) {
      case "LOW_STOCK":
        results.push(
          await productsActions.recommendRestock({ knowledge })
        );
        break;

      case "OUT_OF_STOCK":
        results.push({
          alert: "Produtos sem estoque detectados",
          data: signal.data,
        });
        break;

      case "NEGATIVE_CASHFLOW":
        results.push(
          await financialActions.analyzeFinancial({ knowledge })
        );
        break;

      case "FINANCIAL_SUMMARY":
        results.push(
          await financialActions.getFinancialSummary({ knowledge })
        );
        break;

      case "ORDERS_SUMMARY":
        results.push(await ordersActions.getOrdersSummary({ knowledge }));
        break;

      // Mantém compatibilidade com possíveis sinais existentes
      default:
        results.push({
          message: "Signal não tratado",
          type: signal.type,
          data: signal.data,
        });
    }
  }

  return results;
}
