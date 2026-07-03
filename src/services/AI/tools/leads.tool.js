import { loadLeadsContext } from "../providers/leads.provider.js";

export async function leadsTool() {
  return await loadLeadsContext();
}