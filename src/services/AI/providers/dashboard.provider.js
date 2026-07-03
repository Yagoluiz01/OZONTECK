import { dashboardRepository } from "../repositories/dashboard.repository.js";

export async function loadDashboardContext() {
  const dashboard = await dashboardRepository.getDashboardData();

  const metrics = {
    salesToday: dashboard.salesToday || 0,
    revenueToday: dashboard.revenueToday || 0,
    pendingTasks: dashboard.pendingTasks || 0,
    lowStockProducts: dashboard.lowStockProducts || 0,
  };

  return {
    summary: metrics,
    metrics,
    raw: dashboard,
  };
}