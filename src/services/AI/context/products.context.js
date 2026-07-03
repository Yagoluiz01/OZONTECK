import { getProductsSummary } from "../repositories/products.repository.js";


export async function getProductsContext() {
  const summary = await getProductsSummary();

  return {
    summary,
  };
}