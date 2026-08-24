import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const controllerPath = new URL("../controllers/banners.controller.js", import.meta.url);

function makeResponse() {
  return {
    headers: {},
    statusCode: 0,
    body: null,
    set(name, value) {
      this.headers[name] = value;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return body;
    },
  };
}

async function importController({ service, now }) {
  const key = `__activeBannersCacheTest${Date.now()}${Math.random()}`;
  globalThis[key] = service;
  globalThis[`${key}Now`] = now;

  const originalSource = fs.readFileSync(controllerPath, "utf8");
  const source = originalSource
    .replace(
      'import * as bannersService from "../services/banners.service.js";',
      `const bannersService = globalThis[${JSON.stringify(key)}];`,
    )
    .replace(
      'import { supabaseAdmin } from "../config/supabase.js";',
      "const supabaseAdmin = {};",
    )
    .replaceAll("Date.now()", `globalThis[${JSON.stringify(`${key}Now`)}]()`);

  const moduleUrl = `data:text/javascript;base64,${Buffer.from(
    `${source}\n// ${key}`,
  ).toString("base64")}`;

  return import(moduleUrl);
}

test("100 visitas simultâneas fazem somente uma consulta de banners", async () => {
  let calls = 0;
  let now = 1_000;
  const service = {
    async getActiveBanners() {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return [{ id: "banner-1" }];
    },
  };
  const controller = await importController({ service, now: () => now });

  const responses = Array.from({ length: 100 }, () => makeResponse());
  await Promise.all(
    responses.map((res) => controller.listActiveBanners({}, res)),
  );

  assert.equal(calls, 1);
  assert.ok(responses.every((res) => res.statusCode === 200));
  assert.ok(responses.every((res) => res.body.banners.length === 1));

  now = 2_000;
  const cachedResponse = makeResponse();
  await controller.listActiveBanners({}, cachedResponse);

  assert.equal(calls, 1);
  assert.equal(cachedResponse.headers["X-Ozonteck-Banners-Cache"], "memory");
});

test("cache vencido responde imediatamente e atualiza ao fundo", async () => {
  let calls = 0;
  let now = 1_000;
  let finishRefresh;
  const service = {
    async getActiveBanners() {
      calls += 1;
      if (calls === 1) return [{ id: "antigo" }];
      return new Promise((resolve) => {
        finishRefresh = resolve;
      });
    },
  };
  const controller = await importController({ service, now: () => now });

  await controller.listActiveBanners({}, makeResponse());
  now = 62_000;

  const staleResponse = makeResponse();
  await controller.listActiveBanners({}, staleResponse);

  assert.equal(calls, 2);
  assert.equal(staleResponse.headers["X-Ozonteck-Banners-Cache"], "stale-revalidate");
  assert.equal(staleResponse.body.banners[0].id, "antigo");

  finishRefresh([{ id: "novo" }]);
  await new Promise((resolve) => setImmediate(resolve));

  now = 63_000;
  const refreshedResponse = makeResponse();
  await controller.listActiveBanners({}, refreshedResponse);

  assert.equal(refreshedResponse.headers["X-Ozonteck-Banners-Cache"], "memory");
  assert.equal(refreshedResponse.body.banners[0].id, "novo");
});

test("alterar banner limpa o cache público", async () => {
  let calls = 0;
  let now = 1_000;
  const service = {
    async getActiveBanners() {
      calls += 1;
      return [{ id: `banner-${calls}` }];
    },
    async createBanner(payload) {
      return { id: "criado", ...payload };
    },
  };
  const controller = await importController({ service, now: () => now });

  await controller.listActiveBanners({}, makeResponse());
  await controller.listActiveBanners({}, makeResponse());
  assert.equal(calls, 1);

  const createResponse = makeResponse();
  await controller.createBanner(
    { body: { title: "Novo banner" } },
    createResponse,
  );
  assert.equal(createResponse.statusCode, 201);

  now = 2_000;
  const afterChangeResponse = makeResponse();
  await controller.listActiveBanners({}, afterChangeResponse);

  assert.equal(calls, 2);
  assert.equal(afterChangeResponse.headers["X-Ozonteck-Banners-Cache"], "origin");
});

test("rota permite cache público e nunca armazena resposta de erro", () => {
  const source = fs.readFileSync(controllerPath, "utf8");

  assert.match(source, /stale-while-revalidate=300/);
  assert.match(source, /X-Ozonteck-Banners-Cache/);
  assert.match(source, /res\.set\("Cache-Control", "no-store"\)/);
});
