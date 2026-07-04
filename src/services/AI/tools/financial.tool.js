import { loadAffiliatesContext } from "../providers/financial.provider.js";

// Corrige mismatch de exports em financial.provider.js (ele exporta loadAffiliatesContext).
export async function financialTool() {
  if (typeof loadAffiliatesContext !== "function") {
    throw new Error(
      "financialTool: missing export loadAffiliatesContext in financial.provider.js"
    );
  }
  return await loadAffiliatesContext();
}


