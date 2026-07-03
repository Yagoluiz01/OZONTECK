import { loadProductsContext } from "../providers/products.provider.js";

export async function productsTool() {
  return await loadProductsContext();
}