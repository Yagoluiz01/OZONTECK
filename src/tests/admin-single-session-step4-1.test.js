import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ADMIN_MAX_ACTIVE_SESSIONS } from "../services/adminSession.service.js";
import { supabaseAdmin } from "../config/supabase.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const apiRoot = path.resolve(__dirname, "../..");

function read(relativePath) {
  return fs.readFileSync(path.join(apiRoot, relativePath), "utf8");
}

test("admin permite exatamente uma sessão ativa", () => {
  const source = read("src/services/adminSession.service.js");

  assert.equal(ADMIN_MAX_ACTIVE_SESSIONS, 1);
  assert.match(source, /export const ADMIN_MAX_ACTIVE_SESSIONS = 1/);
  assert.match(source, /create_admin_single_session/);
  assert.match(source, /concurrent_session_limit/);
  assert.doesNotMatch(source, /process\.env\.ADMIN_MAX_ACTIVE_SESSIONS/);
});

test("criação de sessão é delegada ao RPC atômico", () => {
  const source = read("src/services/adminSession.service.js");

  assert.match(source, /supabaseAdmin\.rpc\("create_admin_single_session"/);
  assert.doesNotMatch(
    source,
    /\.from\("admin_sessions"\)\s*\.insert\(/s,
    "A criação não deve voltar a fazer INSERT direto fora da transação atômica."
  );
});

test("migration serializa logins e revoga sessão anterior antes do insert", () => {
  const sql = read("src/sql/20260818-admin-single-session-step4-1.sql");

  assert.match(sql, /pg_advisory_xact_lock/i);
  assert.match(sql, /for update/i);
  assert.match(sql, /revoke_reason[\s\S]*concurrent_session_limit/i);
  assert.match(sql, /update public\.admin_sessions[\s\S]*insert into public\.admin_sessions/i);
  assert.match(sql, /grant execute[\s\S]*service_role/i);
  assert.match(sql, /revoke all[\s\S]*anon[\s\S]*authenticated/i);
});

test(
  "RPC de sessão única existe no banco sem alterar sessão real",
  { skip: process.env.RUN_ADMIN_SINGLE_SESSION_DB_TESTS !== "1" },
  async () => {
    const now = Date.now();
    const probe = await supabaseAdmin.rpc("create_admin_single_session", {
      p_admin_id: crypto.randomUUID(),
      p_token_hash: crypto.randomBytes(32).toString("hex"),
      p_csrf_token_hash: crypto.randomBytes(32).toString("hex"),
      p_created_at: new Date(now).toISOString(),
      p_expires_at: new Date(now + 60 * 60 * 1000).toISOString(),
      p_idle_expires_at: new Date(now + 30 * 60 * 1000).toISOString(),
      p_ip_hash: null,
      p_user_agent_hash: null,
    });

    assert.ok(probe.error, "O probe com admin inexistente deve falhar fechado.");
    assert.notEqual(
      probe.error?.code,
      "PGRST202",
      "O RPC precisa existir no schema cache do PostgREST."
    );
    assert.match(String(probe.error?.message || ""), /admin not found/i);
  }
);
