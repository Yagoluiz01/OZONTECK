import { loadAffiliatesContext } from "../providers/affiliates.provider.js";

export async function affiliatesTool() {
  return await loadAffiliatesContext();
}