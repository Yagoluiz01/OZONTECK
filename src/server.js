import app from "./app.js";
import { syncPendingMelhorEnvioLabels } from "./services/shipping.service.js";
import { runExpiredStockReservationCleanup } from "./jobs/releaseExpiredStockReservations.js";

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

let syncRunning = false;
let syncTimer = null;
let stockCleanupTimer = null;
let startupSyncTimer = null;
let startupStockCleanupTimer = null;

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
