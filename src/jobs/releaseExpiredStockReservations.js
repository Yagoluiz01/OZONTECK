import { releaseExpiredOrderStockReservations } from "../services/orderStock.service.js";

let cleanupRunning = false;

export async function runExpiredStockReservationCleanup({
  trigger = "manual",
  limit = 100,
} = {}) {
  if (cleanupRunning) {
    return {
      success: true,
      skipped: true,
      reason: "cleanup_already_running",
      trigger,
    };
  }

  cleanupRunning = true;

  try {
    const result = await releaseExpiredOrderStockReservations(limit);

    console.log("ORDER STOCK CLEANUP RESULT:", {
      trigger,
      limit,
      result,
    });

    return {
      success: true,
      skipped: false,
      trigger,
      result,
    };
  } finally {
    cleanupRunning = false;
  }
}
