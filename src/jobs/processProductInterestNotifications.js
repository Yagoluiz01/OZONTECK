import { runProductInterestNotificationSweep } from "../services/productInterestNotification.service.js";

export async function processProductInterestNotifications({ trigger = "interval" } = {}) {
  return runProductInterestNotificationSweep({ trigger });
}
