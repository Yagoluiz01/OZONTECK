import app from "./app.js";
import 'module-alias/register';
import aiRoutes from "./services/AI/router/ai.route.js";
import { syncPendingMelhorEnvioLabels } from "./services/shipping.service.js";
import { runExpiredStockReservationCleanup } from "./jobs/releaseExpiredStockReservations.js";
import { reconcilePendingMercadoPagoPayments } from "./jobs/reconcilePendingMercadoPagoPayments.js";
import { runLeadRecoveryReadyNotificationSweep } from "./services/leadRecoveryNotification.service.js";

// Rede de segurança: um erro não tratado em qualquer parte do código não pode
// mais derrubar o processo inteiro. Apenas loga o erro e mantém a API no ar.
// Isso não altera nenhuma regra de negócio nem o comportamento das rotas.
process.on("uncaughtException", (error) => {
  console.error("[UNCAUGHT_EXCEPTION] API continua rodando. Detalhes:", {
    message: error?.message,
    stack: error?.stack,
  });
});

process.on("unhandledRejection", (reason) => {
  console.error("[UNHANDLED_REJECTION] API continua rodando. Detalhes:", reason);
});

const PORT = process.env.PORT || 5000;

const stockCleanupEnabled = !["0", "false", "off", "no"].includes(
  String(process.env.ORDER_STOCK_CLEANUP_ENABLED || "true")
    .trim()
    .toLowerCase()
);

const stockCleanupIntervalMinutes = Math.max(
  5,
  Number(process.env.ORDER_STOCK_CLEANUP_INTERVAL_MINUTES || 15)
);

const stockCleanupBatchLimit = Math.max(
  1,
  Number(process.env.ORDER_STOCK_CLEANUP_BATCH_LIMIT || 100)
);

const syncEnabled = !["0", "false", "off", "no"].includes(
  String(process.env.MELHOR_ENVIO_AUTO_SYNC_ENABLED || "true")
    .trim()
    .toLowerCase()
);

const syncIntervalMinutes = Math.max(
  5,
  Number(process.env.MELHOR_ENVIO_AUTO_SYNC_INTERVAL_MINUTES || 15)
);

const syncBatchLimit = Math.max(
  1,
  Number(process.env.MELHOR_ENVIO_AUTO_SYNC_BATCH_LIMIT || 20)
);

const paymentReconcileEnabled = !["0", "false", "off", "no"].includes(
  String(process.env.MERCADO_PAGO_RECONCILE_ENABLED || "true").trim().toLowerCase()
);

const paymentReconcileIntervalSeconds = Math.max(
  30,
  Number(process.env.MERCADO_PAGO_RECONCILE_INTERVAL_SECONDS || 120)
);

const paymentReconcileBatchLimit = Math.max(
  1,
  Number(process.env.MERCADO_PAGO_RECONCILE_BATCH_LIMIT || 30)
);

const leadRecoveryNotificationsEnabled = !["0", "false", "off", "no"].includes(
  String(process.env.LEAD_RECOVERY_NOTIFICATIONS_ENABLED || "true").trim().toLowerCase()
);

const leadRecoveryNotificationIntervalSeconds = Math.max(
  20,
  Number(process.env.LEAD_RECOVERY_NOTIFICATION_INTERVAL_SECONDS || 30)
);

const leadRecoveryOrderDelayMinutes = Math.max(
  1,
  Number(process.env.LEAD_RECOVERY_ORDER_DELAY_MINUTES || 5)
);

let syncRunning = false;
let syncTimer = null;
let stockCleanupTimer = null;
let startupSyncTimer = null;
let startupStockCleanupTimer = null;
let paymentReconcileTimer = null;
let startupPaymentReconcileTimer = null;
let paymentReconcileRunning = false;

let leadRecoveryNotificationTimer = null;
let startupLeadRecoveryNotificationTimer = null;
let leadRecoveryNotificationRunning = false;

async function runLeadRecoveryNotificationSweep(trigger = "interval") {
  if (!leadRecoveryNotificationsEnabled || leadRecoveryNotificationRunning) return;
  leadRecoveryNotificationRunning = true;

  try {
    const result = await runLeadRecoveryReadyNotificationSweep({
      orderDelayMinutes: leadRecoveryOrderDelayMinutes,
      limit: 80,
    });

    if (result?.created > 0) {
      console.log(
        "LEAD RECOVERY NOTIFICATIONS: " +
          JSON.stringify({ trigger, checked: result.checked, eligible: result.eligible, created: result.created })
      );
    }
  } catch (error) {
    console.error("LEAD RECOVERY NOTIFICATIONS ERROR:", {
      trigger,
      message: error?.message || String(error),
    });
  } finally {
    leadRecoveryNotificationRunning = false;
  }
}

async function runPaymentReconciliation(trigger = "interval") {
  if (!paymentReconcileEnabled || paymentReconcileRunning) return;
  paymentReconcileRunning = true;

  try {
    const result = await reconcilePendingMercadoPagoPayments({
      trigger,
      limit: paymentReconcileBatchLimit,
    });
    console.log("MERCADO PAGO AUTO RECONCILE RESULT: " + JSON.stringify(result));
  } catch (error) {
    console.error("MERCADO PAGO AUTO RECONCILE FATAL ERROR:", {
      trigger,
      message: error?.message || String(error),
    });
  } finally {
    paymentReconcileRunning = false;
  }
}

async function runMelhorEnvioAutoSync(trigger = "interval") {
  if (!syncEnabled) {
    return;
  }

  if (syncRunning) {
    console.log(
      `MELHOR ENVIO AUTO SYNC: execução ignorada (${trigger}) porque outra sincronização ainda está rodando`
    );
    return;
  }

  syncRunning = true;

  try {
    console.log(
      `MELHOR ENVIO AUTO SYNC: iniciando (${trigger}) com limite ${syncBatchLimit}`
    );

    const result = await syncPendingMelhorEnvioLabels({
      limit: syncBatchLimit
    });

    console.log(
      "MELHOR ENVIO AUTO SYNC RESULT: " +
        JSON.stringify({
          trigger,
          checked: result.checked,
          updated: result.updated,
          pending: result.pending
        })
    );
  } catch (error) {
    console.error(
      "MELHOR ENVIO AUTO SYNC FATAL ERROR: " +
        JSON.stringify({
          trigger,
          message: error.message
        })
    );
  } finally {
    syncRunning = false;
  }
}

const server = app.listen(PORT, () => {
  console.log(`API OZONTECK rodando em http://localhost:${PORT}`);

  if (syncEnabled) {
    console.log(
      `MELHOR ENVIO AUTO SYNC: ativado para rodar a cada ${syncIntervalMinutes} minuto(s)`
    );

    startupSyncTimer = setTimeout(() => {
      runMelhorEnvioAutoSync("startup");
    }, 30000);

    syncTimer = setInterval(() => {
      runMelhorEnvioAutoSync("interval");
    }, syncIntervalMinutes * 60 * 1000);
  } else {
    console.log("MELHOR ENVIO AUTO SYNC: desativado por configuração");
  }

  if (paymentReconcileEnabled) {
    console.log(
      `MERCADO PAGO AUTO RECONCILE: ativado a cada ${paymentReconcileIntervalSeconds} segundo(s)`
    );

    startupPaymentReconcileTimer = setTimeout(() => {
      runPaymentReconciliation("startup");
    }, 20000);

    paymentReconcileTimer = setInterval(() => {
      runPaymentReconciliation("interval");
    }, paymentReconcileIntervalSeconds * 1000);
  } else {
    console.log("MERCADO PAGO AUTO RECONCILE: desativado por configuração");
  }

  if (leadRecoveryNotificationsEnabled) {
    console.log(
      `LEAD RECOVERY NOTIFICATIONS: ativado a cada ${leadRecoveryNotificationIntervalSeconds} segundo(s); pedido disponível após ${leadRecoveryOrderDelayMinutes} minuto(s)`
    );

    startupLeadRecoveryNotificationTimer = setTimeout(() => {
      runLeadRecoveryNotificationSweep("startup");
    }, 12000);

    leadRecoveryNotificationTimer = setInterval(() => {
      runLeadRecoveryNotificationSweep("interval");
    }, leadRecoveryNotificationIntervalSeconds * 1000);
  } else {
    console.log("LEAD RECOVERY NOTIFICATIONS: desativado por configuração");
  }

  if (stockCleanupEnabled) {
    console.log(
      `ORDER STOCK CLEANUP: ativado para rodar a cada ${stockCleanupIntervalMinutes} minuto(s)`
    );

    startupStockCleanupTimer = setTimeout(() => {
      runExpiredStockReservationCleanup({
        trigger: "startup",
        limit: stockCleanupBatchLimit,
      }).catch((error) => {
        console.error("ORDER STOCK CLEANUP STARTUP ERROR:", error?.message || error);
      });
    }, 45000);

    stockCleanupTimer = setInterval(() => {
      runExpiredStockReservationCleanup({
        trigger: "interval",
        limit: stockCleanupBatchLimit,
      }).catch((error) => {
        console.error("ORDER STOCK CLEANUP INTERVAL ERROR:", error?.message || error);
      });
    }, stockCleanupIntervalMinutes * 60 * 1000);
  } else {
    console.log("ORDER STOCK CLEANUP: desativado por configuração");
  }
});

function clearBackgroundTimers() {
  if (syncTimer) clearInterval(syncTimer);
  if (stockCleanupTimer) clearInterval(stockCleanupTimer);
  if (startupSyncTimer) clearTimeout(startupSyncTimer);
  if (startupStockCleanupTimer) clearTimeout(startupStockCleanupTimer);
  if (paymentReconcileTimer) clearInterval(paymentReconcileTimer);
  if (startupPaymentReconcileTimer) clearTimeout(startupPaymentReconcileTimer);
  if (leadRecoveryNotificationTimer) clearInterval(leadRecoveryNotificationTimer);
  if (startupLeadRecoveryNotificationTimer) clearTimeout(startupLeadRecoveryNotificationTimer);
}

let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`API OZONTECK: encerramento solicitado por ${signal}`);
  clearBackgroundTimers();

  const forceExitTimer = setTimeout(() => {
    console.error("API OZONTECK: encerramento forçado após timeout.");
    process.exit(1);
  }, 10000);
  forceExitTimer.unref();

  server.close((error) => {
    clearTimeout(forceExitTimer);

    if (error) {
      console.error("API OZONTECK: erro ao encerrar servidor HTTP:", error);
      process.exit(1);
      return;
    }

    process.exit(0);
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
