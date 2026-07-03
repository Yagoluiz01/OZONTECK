import { loadFinancialContext } from "../providers/financial.provider.js";

export async function financialTool() {
  return await loadFinancialContext();
}