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

  // Write operations - execute via tools/products.tool.js (real CRUD routes)
  createProduct: async ({ knowledge, payload }) => {
    // tools are executed inside the tools layer; actions just pass through
    // to keep agent policy centralized in tools.
    return {
      mode: "products_create_pending",
      payload,
    };
  },

  updateProduct: async ({ knowledge, payload }) => {
    return {
      mode: "products_update_pending",
      payload,
    };
  },

  deleteProduct: async ({ knowledge, payload }) => {
    return {
      mode: "products_delete_pending",
      payload,
    };
  },
};
