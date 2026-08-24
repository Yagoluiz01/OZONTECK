import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  fetchWithTimeout,
  withTimeout,
} from "../utils/upstreamTimeout.js";

test("operação lenta termina no prazo em vez de prender a API", async () => {
  const startedAt = Date.now();

  await assert.rejects(
    () => withTimeout(new Promise(() => {}), {
      timeoutMs: 25,
      label: "Origem de teste",
    }),
    (error) => error?.code === "UPSTREAM_TIMEOUT" && error?.statusCode === 504,
  );

  assert.ok(Date.now() - startedAt < 500);
});

test("fetch lento é cancelado e libera a conexão", async () => {
  const originalFetch = global.fetch;
  let aborted = false;

  global.fetch = async (url, options = {}) => new Promise((resolve, reject) => {
    options.signal.addEventListener("abort", () => {
      aborted = true;
      reject(new Error("abortado"));
    }, { once: true });
  });

  try {
    await assert.rejects(
      () => fetchWithTimeout("https://example.test", {}, {
        timeoutMs: 25,
        label: "Fetch de teste",
      }),
      (error) => error?.code === "UPSTREAM_TIMEOUT",
    );
    assert.equal(aborted, true);
  } finally {
    global.fetch = originalFetch;
  }
});

test("resposta rápida continua exatamente igual", async () => {
  const expected = { ok: true };
  const result = await withTimeout(Promise.resolve(expected), {
    timeoutMs: 100,
  });

  assert.equal(result, expected);
});

test("timeout cobre somente as origens públicas principais", () => {
  const storeRoutes = fs.readFileSync(
    new URL("../routes/store.routes.js", import.meta.url),
    "utf8",
  );
  const themeService = fs.readFileSync(
    new URL("../services/storeTheme.service.js", import.meta.url),
    "utf8",
  );
  const bannersService = fs.readFileSync(
    new URL("../services/banners.service.js", import.meta.url),
    "utf8",
  );

  assert.match(storeRoutes, /label: "Produtos públicos"/);
  assert.match(storeRoutes, /label: "Categorias públicas"/);
  assert.match(storeRoutes, /label: "Pixels públicos de marketing"/);
  assert.match(themeService, /label: "Tema público"/);
  assert.match(bannersService, /label: "Banners públicos"/);

  assert.match(
    storeRoutes,
    /async function fetchProductsMap\(\)[\s\S]*?fetchProductsTable\(\)/,
  );
});
