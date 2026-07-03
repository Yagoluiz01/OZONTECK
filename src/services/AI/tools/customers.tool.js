import { loadCustomersContext } from "../providers/customers.provider.js";

export async function customersTool() {
  return await loadCustomersContext();
}