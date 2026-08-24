import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const servicePath = new URL("../services/storeTheme.service.js", import.meta.url);
const timeoutPath = new URL("../utils/upstreamTimeout.js", import.meta.url);
const routePath = new URL("../routes/storeTheme.routes.js", import.meta.url);

async function importServiceWithClock(now) {
  const key = `__storeThemeNow${Date.now()}${Math.random()}`;
  globalThis[key] = now;

  const originalSource = fs.readFileSync(servicePath, "utf8");
  const timeoutSource = fs.readFileSync(timeoutPath, "utf8");
  const timeoutModuleUrl = `data:text/javascript;base64,${Buffer.from(
    timeoutSource,
  ).toString("base64")}`;
  const source = originalSource
    .replace(
      'import { env } from "../config/env.js";',
      'const env = { supabaseUrl: "https://supabase.test", supabaseServiceRoleKey: "test-key" };',
    )
    .replace(
      `import {
  fetchWithTimeout,
  normalizeTimeoutMs,
} from "../utils/upstreamTimeout.js";`,
      `import { fetchWithTimeout, normalizeTimeoutMs } from ${JSON.stringify(timeoutModuleUrl)};`,
    )
    .replaceAll("Date.now()", `globalThis[${JSON.stringify(key)}]()`);

  const moduleUrl = `data:text/javascript;base64,${Buffer.from(
    `${source}\n// ${key}`,
  ).toString("base64")}`;

  return import(moduleUrl);
}

function responseFor(url, brandName) {
  const target = String(url);

  if (target.includes("/rpc/get_store_settings")) {
    return new Response(JSON.stringify([{ store_name: brandName }]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (target.includes("store_theme_settings")) {
    return new Response(JSON.stringify([{ brand_name: brandName }]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (target.includes("store_color_palettes")) {
    return new Response("[]", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  throw new Error(`Requisição inesperada no teste: ${target}`);
}

test("tema vencido responde na hora e atualiza as três leituras ao fundo", async () => {
  const originalFetch = global.fetch;
  let now = 1_000;
  let requests = 0;
  let releaseRefresh;
  const refreshGate = new Promise((resolve) => {
    releaseRefresh = resolve;
  });

  global.fetch = async (url) => {
    requests += 1;
    const isRefresh = requests > 3;
    if (isRefresh) await refreshGate;
    return responseFor(url, isRefresh ? "Marca nova" : "Marca antiga");
  };

  try {
    const service = await importServiceWithClock(() => now);
    const origin = await service.getPublicStoreThemeSnapshot();

    assert.equal(origin.source, "origin");
    assert.equal(origin.data.theme.brandName, "Marca antiga");
    assert.equal(requests, 3);

    now = 302_000;
    const stale = await service.getPublicStoreThemeSnapshot();

    assert.equal(stale.source, "stale-revalidate");
    assert.equal(stale.data.theme.brandName, "Marca antiga");
    assert.equal(requests, 6);

    releaseRefresh();
    await new Promise((resolve) => setImmediate(resolve));

    now = 303_000;
    const refreshed = await service.getPublicStoreThemeSnapshot();

    assert.equal(refreshed.source, "memory");
    assert.equal(refreshed.data.theme.brandName, "Marca nova");
    assert.equal(requests, 6);
  } finally {
    global.fetch = originalFetch;
  }
});

test("rota informa a origem do cache e não armazena erros", () => {
  const source = fs.readFileSync(routePath, "utf8");

  assert.match(source, /X-Ozonteck-Theme-Cache/);
  assert.match(source, /stale-while-revalidate=900/);
  assert.match(source, /res\.set\("Cache-Control", "no-store"\)/);
});
