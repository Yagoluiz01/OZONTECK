import { processMarketingCampaignJobs } from "./marketingCampaignWorker.service.js";

let scheduled = false;
let running = false;
let rerunRequested = false;
let currentRun = Promise.resolve();

function isTruthy(value) {
  return ["1", "true", "yes", "sim", "on"].includes(
    String(value || "").trim().toLowerCase()
  );
}

export function getInlineMarketingDispatcherConfig(overrides = {}) {
  const intervalSeconds = Math.trunc(
    Number(
      overrides.intervalSeconds ??
        process.env.MARKETING_CAMPAIGN_INLINE_RECOVERY_INTERVAL_SECONDS ??
        30
    )
  );

  return {
    enabled:
      overrides.enabled ??
      isTruthy(process.env.MARKETING_CAMPAIGN_INLINE_DISPATCH_ENABLED),
    intervalSeconds: Number.isFinite(intervalSeconds)
      ? Math.max(15, Math.min(300, intervalSeconds))
      : 30,
  };
}

async function drainInlineQueue(trigger, runner) {
  scheduled = false;
  running = true;

  try {
    do {
      rerunRequested = false;
      const result = await runner({
        trigger,
        config: { enabled: true },
      });

      if (Number(result?.claimed || 0) > 0) {
        console.log(
          "MARKETING CAMPAIGN INLINE RESULT: " +
            JSON.stringify({
              trigger,
              claimed: result.claimed || 0,
              completed: result.completed || 0,
              failed: result.failed || 0,
            })
        );
      }
    } while (rerunRequested);
  } catch (error) {
    console.error("MARKETING CAMPAIGN INLINE ERROR:", {
      trigger,
      code: error?.code || null,
      message: error?.message || String(error),
    });
  } finally {
    running = false;
  }
}

export function triggerInlineMarketingCampaignProcessing(
  trigger = "inline",
  {
    config: configOverrides = {},
    runner = processMarketingCampaignJobs,
  } = {}
) {
  const config = getInlineMarketingDispatcherConfig(configOverrides);
  if (!config.enabled) {
    return { enabled: false, scheduled: false, coalesced: false };
  }

  rerunRequested = true;
  if (scheduled || running) {
    return { enabled: true, scheduled: false, coalesced: true };
  }

  scheduled = true;
  setImmediate(() => {
    currentRun = drainInlineQueue(trigger, runner);
  });

  return { enabled: true, scheduled: true, coalesced: false };
}

export async function waitForInlineMarketingCampaignProcessing() {
  if (scheduled) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  await currentRun;
}
