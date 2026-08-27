import "dotenv/config";

import {
  getMarketingCampaignWorkerConfig,
  processMarketingCampaignJobs,
} from "../services/marketingCampaignWorker.service.js";

let stopping = false;
let currentRun = null;

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`MARKETING CAMPAIGN WORKER: encerramento solicitado por ${signal}.`);

  try {
    await currentRun;
    console.log("MARKETING CAMPAIGN WORKER: job atual finalizado com segurança.");
    process.exit(0);
  } catch (error) {
    console.error("MARKETING CAMPAIGN WORKER: falha durante encerramento.", {
      message: error?.message || String(error),
    });
    process.exit(1);
  }
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

const pollSeconds = Math.max(
  5,
  Math.min(300, Number(process.env.MARKETING_CAMPAIGN_WORKER_INTERVAL_SECONDS || 15))
);
const config = getMarketingCampaignWorkerConfig();

if (!config.enabled) {
  console.log("MARKETING CAMPAIGN WORKER: desativado por configuração.");
  process.exit(0);
}

console.log(
  `MARKETING CAMPAIGN WORKER: iniciado; intervalo=${pollSeconds}s; jobLimit=${config.jobLimit}.`
);

while (!stopping) {
  try {
    currentRun = processMarketingCampaignJobs({ trigger: "background_worker" });
    const result = await currentRun;
    if (result.claimed > 0) {
      console.log(
        "MARKETING CAMPAIGN WORKER RESULT: " +
          JSON.stringify({
            claimed: result.claimed,
            completed: result.completed,
            failed: result.failed,
          })
      );
    }
  } catch (error) {
    console.error("MARKETING CAMPAIGN WORKER ERROR:", {
      code: error?.code || null,
      message: error?.message || String(error),
    });
  } finally {
    currentRun = null;
  }

  if (!stopping) await wait(pollSeconds * 1000);
}
