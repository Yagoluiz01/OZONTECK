export const ordersActions = {
  getOrdersSummary: async ({ knowledge }) => {
    const data = knowledge.orders?.summary ?? {};

    return {
      total: data.total ?? 0,
      pending: data.pending ?? 0,
      processing: data.processing ?? 0,
      shipped: data.shipped ?? 0,
      delivered: data.delivered ?? 0,
      cancelled: data.cancelled ?? 0,
    };
  },

  analyzeOrders: async ({ knowledge }) => {
    const data = knowledge.orders?.summary ?? {};

    return {
      total: data.total ?? 0,
      pending: data.pending ?? 0,
      recommendation: "Priorizar pedidos pendentes para reduzir atrasos.",
    };
  },

  pendingOrders: async ({ knowledge }) => {
    return knowledge.orders?.pending ?? [];
  },
};