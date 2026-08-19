import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const apiRoot = path.resolve(__dirname, "../..");
const repoRoot = path.resolve(apiRoot, "..");
const adminRoot = path.resolve(repoRoot, "ozonteck-admin");

function createResponseRecorder() {
  return {
    statusCode: 200,
    payload: null,
    clearedCookies: [],
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
    clearCookie(name, options) {
      this.clearedCookies.push({ name, options });
      return this;
    },
  };
}

test("admin rejeita Authorization Bearer sem cookie de sessão", async (t) => {
  let requireAdminAuth;
  try {
    const middlewareUrl = pathToFileURL(
      path.join(apiRoot, "src/middlewares/auth.middleware.js")
    ).href;
    ({ requireAdminAuth } = await import(middlewareUrl));
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND") {
      t.skip("dependências da API não estão instaladas neste ambiente");
      return;
    }
    throw error;
  }

  const req = {
    method: "GET",
    originalUrl: "/api/auth/me",
    headers: {
      authorization: "Bearer jwt-legado-nao-deve-ser-aceito",
    },
  };
  const res = createResponseRecorder();
  let nextCalled = false;

  await requireAdminAuth(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
  assert.equal(res.payload?.success, false);
  assert.match(String(res.payload?.message || ""), /sessão administrativa não enviada/i);
});

test("middleware administrativo não contém fallback JWT/Bearer", () => {
  const source = fs.readFileSync(path.join(apiRoot, "src/middlewares/auth.middleware.js"), "utf8");

  assert.doesNotMatch(source, /jsonwebtoken/);
  assert.doesNotMatch(source, /jwt\.verify\s*\(/);
  assert.doesNotMatch(source, /legacy_bearer/);
  assert.doesNotMatch(source, /headers\.authorization/);
  assert.doesNotMatch(source, /startsWith\(["']Bearer /);
});

test("login administrativo não gera JWT nem expõe endpoint de upgrade legado", () => {
  const source = fs.readFileSync(path.join(apiRoot, "src/routes/auth.routes.js"), "utf8");

  assert.doesNotMatch(source, /jwt\.sign\s*\(/);
  assert.doesNotMatch(source, /\/session\/upgrade/);
  assert.doesNotMatch(source, /x-admin-session-mode/i);
  assert.match(source, /secure_session/);
  assert.match(source, /setAdminSessionCookie/);
});

test("frontend não possui rotina de upgrade de JWT legado", () => {
  // Executa a validação cruzada quando API e Admin estão lado a lado.
  if (!fs.existsSync(adminRoot)) return;

  const authSource = fs.readFileSync(path.join(adminRoot, "src/services/auth.js"), "utf8");
  const fetchSource = fs.readFileSync(path.join(adminRoot, "src/services/secureAdminFetch.js"), "utf8");
  const loginSource = fs.readFileSync(path.join(adminRoot, "src/pages/auth/Login.jsx"), "utf8");

  assert.doesNotMatch(authSource, /readLegacyToken/);
  assert.doesNotMatch(authSource, /upgradeLegacyAdminSession/);
  assert.doesNotMatch(fetchSource, /upgradeLegacyAdminSession/);
  assert.doesNotMatch(loginSource, /X-Admin-Session-Mode/i);

  // Defesa em profundidade: módulos antigos ainda podem montar Authorization,
  // então a camada central continua removendo o header antes da rede.
  assert.match(fetchSource, /headers\.delete\(["']Authorization["']\)/);
});
