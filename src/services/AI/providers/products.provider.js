import { productsRepository } from "../repositories/products.repository.js";

export async function loadProductsContext() {
  const products = await productsRepository.getProducts();

  const lowStock = products.filter(
    p => Number(p.stock_quantity || 0) > 0 && Number(p.stock_quantity || 0) <= 5
  );

  const outOfStock = products.filter(
    p => Number(p.stock_quantity || 0) <= 0
  );

  return {
    summary: {
      total: products.length,
      active: products.filter(p => p.status === "active").length,
      inactive: products.filter(p => p.status === "inactive").length,
      lowStock: lowStock.length,
      outOfStock: outOfStock.length,
    },

    list: products,
    lowStock,
    outOfStock,
  };
}