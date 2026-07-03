import { ordersRepository } from "../repositories/orders.repository.js";

export async function loadOrdersContext() {
  const orders = await ordersRepository.getOrders();

  const pending = orders.filter(o => o.status === "pending");
  const processing = orders.filter(o => o.status === "processing");
  const shipped = orders.filter(o => o.status === "shipped");
  const delivered = orders.filter(o => o.status === "delivered");
  const cancelled = orders.filter(o => o.status === "cancelled");

  return {
    summary: {
      total: orders.length,
      pending: pending.length,
      processing: processing.length,
      shipped: shipped.length,
      delivered: delivered.length,
      cancelled: cancelled.length,
    },

    list: orders,
    pending,
    processing,
    shipped,
    delivered,
    cancelled,
  };
}