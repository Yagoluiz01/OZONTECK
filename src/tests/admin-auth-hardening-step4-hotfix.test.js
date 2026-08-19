import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const middlewarePath = path.resolve(__dirname, "../middlewares/auth.middleware.js");
const source = fs.readFileSync(middlewarePath, "utf8");

test("middleware carrega session_version do admin", () => {
  assert.match(
    source,
    /is_master,\s*auth_user_id,\s*session_version\s*`\)/s,
    "A consulta do admin precisa carregar session_version."
  );
});

test("middleware importa a função de revogação usada no mismatch", () => {
  assert.match(
    source,
    /revokeAdminSessionId/,
    "revokeAdminSessionId precisa estar importada e disponível."
  );
});

test("mismatch de versão continua falhando fechado", () => {
  assert.match(source, /sessionVersion !== currentSessionVersion/);
  assert.match(source, /ADMIN_SESSION_VERSION_MISMATCH/);
});
