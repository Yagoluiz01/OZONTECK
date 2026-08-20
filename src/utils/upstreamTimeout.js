export function normalizeTimeoutMs(value, fallback = 8_000) {
  const number = Number(value);
  const safeFallback = Number.isFinite(Number(fallback)) && Number(fallback) > 0
    ? Number(fallback)
    : 8_000;

  if (!Number.isFinite(number) || number <= 0) return safeFallback;
  return Math.min(120_000, Math.max(1, Math.trunc(number)));
}

function createTimeoutError(label, timeoutMs) {
  const error = new Error(
    `${String(label || "Serviço externo")} demorou além de ${timeoutMs} ms.`,
  );
  error.code = "UPSTREAM_TIMEOUT";
  error.statusCode = 504;
  return error;
}

export async function withTimeout(
  operation,
  { timeoutMs = 8_000, label = "Serviço externo" } = {},
) {
  const safeTimeoutMs = normalizeTimeoutMs(timeoutMs);
  let timer = null;

  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      reject(createTimeoutError(label, safeTimeoutMs));
    }, safeTimeoutMs);
  });

  try {
    return await Promise.race([Promise.resolve(operation), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function fetchWithTimeout(
  url,
  options = {},
  { timeoutMs = 8_000, label = "Serviço externo" } = {},
) {
  const safeTimeoutMs = normalizeTimeoutMs(timeoutMs);
  const controller = new AbortController();
  const externalSignal = options.signal;
  let timedOut = false;

  const forwardAbort = () => {
    controller.abort(externalSignal?.reason);
  };

  if (externalSignal) {
    if (externalSignal.aborted) {
      forwardAbort();
    } else {
      externalSignal.addEventListener("abort", forwardAbort, { once: true });
    }
  }

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, safeTimeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } catch (error) {
    if (timedOut) {
      throw createTimeoutError(label, safeTimeoutMs);
    }

    throw error;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener?.("abort", forwardAbort);
  }
}
