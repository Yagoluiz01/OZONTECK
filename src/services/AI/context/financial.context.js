import { env } from "../../../config/env.js";
import { getFinancialSummary } from "../../adminFinancial.service.js";

export async function getFinancialContext() {
  try {
    const summary = await getFinancialSummary("30d");

    return summary;

  } catch (error) {
    console.error("[AI_FINANCIAL_CONTEXT]", error);

    return {
      error: "Erro ao carregar dados financeiros."
    };
  }
}