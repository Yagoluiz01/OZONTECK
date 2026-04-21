import app from "./app.js";
import { syncPendingMelhorEnvioLabels } from "./services/shipping.service.js";

const PORT = process.env.PORT || 5000;

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

app.listen(PORT, () => {
  console.log(`API OZONTECK rodando em http://localhost:${PORT}`);

  if (!syncEnabled) {
    console.log("MELHOR ENVIO AUTO SYNC: desativado por configuração");
    return;
  }

  console.log(
    `MELHOR ENVIO AUTO SYNC: ativado para rodar a cada ${syncIntervalMinutes} minuto(s)`
  );

  setTimeout(() => {
    runMelhorEnvioAutoSync("startup");
  }, 30000);

  syncTimer = setInterval(() => {
    runMelhorEnvioAutoSync("interval");
  }, syncIntervalMinutes * 60 * 1000);
});

process.on("SIGTERM", () => {
  if (syncTimer) {
    clearInterval(syncTimer);
  }
});

process.on("SIGINT", () => {
  if (syncTimer) {
    clearInterval(syncTimer);
  }
});