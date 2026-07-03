import { loadOrdersContext } from "../providers/orders.provider.js";

export async function ordersTool() {
  return await loadOrdersContext();
}