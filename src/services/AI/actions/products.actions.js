export const productsActions = {
  getProductsSummary: async ({ knowledge }) => {
    const data = knowledge.products?.summary ?? {};

    return {
      total: data.total ?? 0,
      active: data.active ?? 0,
      inactive: data.inactive ?? 0,
    };
  },

  analyzeStock: async ({ knowledge }) => {
    return {
      lowStock: knowledge.products?.lowStock ?? [],
      outOfStock: knowledge.products?.outOfStock ?? [],
    };
  },

  recommendRestock: async ({ knowledge }) => {
    return {
      recommendation:
        "Priorizar reposição de produtos com estoque baixo ou zerado.",
      products: knowledge.products?.lowStock ?? [],
    };
  },

  // Write operations are handled by tools layer (products_write).
  // Actions should only generate an intent payload consumível pelo dispatcher.
  createProduct: async ({ knowledge, payload }) => {
    return {
      intent: "products.write",
      operation: { type: "create", payload },
    };
  },

  updateProduct: async ({ knowledge, payload }) => {
    return {
      intent: "products.write",
      operation: { type: "update", payload },
    };
  },

  deleteProduct: async ({ knowledge, payload }) => {
    return {
      intent: "products.write",
      operation: { type: "delete", payload },
    };
  },
};
