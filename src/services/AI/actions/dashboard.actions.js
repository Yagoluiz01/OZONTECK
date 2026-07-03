export const dashboardActions = {
  getDashboardSummary: async ({ knowledge }) => {
    return knowledge.dashboard?.summary ?? {};
  },

  analyzeDashboard: async ({ knowledge }) => {
    const data = knowledge.dashboard?.summary ?? {};

    return {
      salesToday: data.salesToday ?? 0,
      revenueToday: data.revenueToday ?? 0,
      pendingTasks: data.pendingTasks ?? 0,
      lowStockProducts: data.lowStockProducts ?? 0,
      recommendation: "Monitorar indicadores diariamente.",
    };
  },

  businessHealth: async ({ knowledge }) => {
    return {
      status: "healthy",
      indicators: knowledge.dashboard?.summary ?? {},
    };
  },
};