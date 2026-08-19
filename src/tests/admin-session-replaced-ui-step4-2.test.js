import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function read(relativePath) {
  return fs.readFileSync(path.resolve(__dirname, relativePath), "utf8");
}

test("backend diferencia sessão substituída de sessão expirada", () => {
  const service = read("../services/adminSession.service.js");
  const middleware = read("../middlewares/auth.middleware.js");

  assert.match(service, /concurrent_session_limit/);
  assert.match(service, /ADMIN_SESSION_REPLACED/);
  assert.match(service, /Um novo login foi realizado nesta conta/);
  assert.match(middleware, /safeSessionCode/);
  assert.match(middleware, /code:\s*safeSessionCode/);
});

test("fetch seguro lê o código da resposta sem consumir o body original", () => {
  const frontend = read("../../../ozonteck-admin/src/services/secureAdminFetch.js");

  assert.match(frontend, /response\.clone\(\)\.json/);
  assert.match(frontend, /ADMIN_SESSION_INVALID/);
  assert.match(frontend, /await signalInvalidSession/);
});

test("AuthContext abre tela específica para sessão substituída", () => {
  const context = read("../../../ozonteck-admin/src/contexts/AuthContext.jsx");

  assert.match(context, /SessionReplacedScreen/);
  assert.match(context, /ADMIN_SESSION_REPLACED/);
  assert.match(context, /sessionEndReason === "replaced"/);
  assert.match(context, /replaceSession/);
});

test("tela explica sessão única sem expor dados do outro acesso", () => {
  const screen = read("../../../ozonteck-admin/src/components/security/SessionReplacedScreen.jsx");

  assert.match(screen, /NOVO LOGIN DETECTADO/);
  assert.match(screen, /apenas uma sessão administrativa pode ficar/);
  assert.match(screen, /não reconhece o novo login/i);
  assert.doesNotMatch(screen, /\bIP\b|localização|endereço IP/i);
});
