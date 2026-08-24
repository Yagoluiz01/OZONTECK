import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const servicePath = new URL("../services/storeTheme.service.js", import.meta.url);
const timeoutPath = new URL("../utils/upstreamTimeout.js", import.meta.url);
const routePath = new URL("../routes/storeTheme.routes.js", import.meta.url);

async function importServiceWithFakeEnvironment() {
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
    );

  const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
  return import(moduleUrl);
}

test("tema público reaproveita uma única carga para 100 chamadas concorrentes", async () => {
  const originalFetch = global.fetch;
  let readRequests = 0;

  global.fetch = async (url, options = {}) => {
    const target = String(url);
    const method = String(options.method || "GET").toUpperCase();

    if (
      method === "GET" ||
      target.includes("/rest/v1/rpc/get_store_settings")
    ) {
      readRequests += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return new Response("[]", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (target.includes("store_theme_settings?on_conflict=id")) {
      return new Response(`[${options.body}]`, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    throw new Error(`Requisição inesperada no teste: ${method} ${target}`);
  };

  try {
    const service = await importServiceWithFakeEnvironment();
    const responses = await Promise.all(
      Array.from({ length: 100 }, () => service.getPublicStoreTheme()),
    );

    assert.equal(readRequests, 3);
    assert.equal(responses.length, 100);
    assert.ok(responses.every((response) => response.theme?.brandName === "OZONTECK"));

    await service.getPublicStoreTheme();
    assert.equal(readRequests, 3, "uma leitura seguinte deve usar o cache quente");

    await service.saveStoreTheme({ brandName: "Nova marca" });
    await service.getPublicStoreTheme();
    assert.equal(readRequests, 6, "salvar o tema deve invalidar e recarregar o cache");
  } finally {
    global.fetch = originalFetch;
  }
});

test("rota pública permite cache e não armazena a resposta de erro", () => {
  const source = fs.readFileSync(routePath, "utf8");

  assert.match(source, /public, max-age=60, s-maxage=300, stale-while-revalidate=900/);
  assert.match(source, /res\.set\("Cache-Control", "no-store"\)/);
});
