import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { supabaseAdmin } from "../config/supabase.js";
import {
  ADMIN_MAX_ACTIVE_SESSIONS,
  getAdminSessionCookieOptions,
} from "../services/adminSession.service.js";
import {
  hashAdminLoginIdentity,
} from "../services/adminLoginGuard.service.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const apiRoot = path.resolve(__dirname, "../..");
const repoRoot = path.resolve(apiRoot, "..");
const adminRoot = path.resolve(repoRoot, "ozonteck-admin");

function read(relativePath) {
  return fs.readFileSync(path.join(apiRoot, relativePath), "utf8");
}

test("sessão administrativa limita concorrência, versiona segurança e usa cookie de alta prioridade", () => {
  const source = read("src/services/adminSession.service.js");
  const middleware = read("src/middlewares/auth.middleware.js");
  const options = getAdminSessionCookieOptions();

  assert.equal(options.httpOnly, true);
  assert.equal(options.priority, "high");
  assert.ok(ADMIN_MAX_ACTIVE_SESSIONS >= 1);
  assert.match(source, /concurrent_session_limit/);
  assert.match(source, /session_version/);
  assert.match(source, /user_agent_changed/);
  assert.match(middleware, /ADMIN_SESSION_VERSION_MISMATCH/);
});

test("login usa bloqueio persistente por conta e resposta genérica", () => {
  const source = read("src/routes/auth.routes.js");
  const limiter = read("src/middlewares/rate-limit.middleware.js");

  assert.match(source, /checkAdminLoginGuard/);
  assert.match(source, /registerAdminLoginFailure/);
  assert.match(source, /registerAdminLoginSuccess/);
  assert.match(source, /enforceMinimumAdminLoginDuration/);
  assert.match(source, /Credenciais inválidas/);
  assert.match(source, /status\(429\)/);
  assert.match(limiter, /skipSuccessfulRequests:\s*true/);
});

test("identidade usada no bloqueio de login é HMAC e não expõe o e-mail", () => {
  const email = "Admin.Example+security@example.com";
  const hashed = hashAdminLoginIdentity(email);

  assert.match(hashed, /^[a-f0-9]{64}$/);
  assert.equal(hashed.includes("example.com"), false);
  assert.notEqual(
    hashed,
    crypto.createHash("sha256").update(email.toLowerCase()).digest("hex")
  );
  assert.equal(hashAdminLoginIdentity(email), hashed);
});

test("reset de senha exige senha longa, valida identidade e revoga sessões", () => {
  const source = read("src/routes/auth.routes.js");

  assert.match(source, /value\.length < 15/);
  assert.match(source, /getSupabaseUserFromAccessToken/);
  assert.match(source, /invalidateAdminSessionsAfterPasswordReset/);
  assert.match(read("src/sql/20260818-admin-auth-hardening-step4.sql"), /password_changed/);

  if (fs.existsSync(adminRoot)) {
    const resetSource = fs.readFileSync(
      path.join(adminRoot, "src/pages/auth/ResetPassword.jsx"),
      "utf8"
    );
    assert.match(resetSource, /password\.length < 15/);
    assert.doesNotMatch(resetSource, /refresh_token:\s*recovery/);
    assert.doesNotMatch(resetSource, /console\.warn\([\s\S]*window\.location\.hash/);
    assert.match(resetSource, /history\.replaceState/);
  }
});

test("migration da Etapa 4 contém RLS, guard atômico e versionamento", () => {
  const sql = read("src/sql/20260818-admin-auth-hardening-step4.sql");

  assert.match(sql, /alter table public\.admins[\s\S]*session_version/i);
  assert.match(sql, /alter table public\.admin_sessions[\s\S]*session_version/i);
  assert.match(sql, /create table if not exists public\.admin_login_guard/i);
  assert.match(sql, /enable row level security/i);
  assert.match(sql, /for update/i);
  assert.match(sql, /admin_login_guard_failure/i);
  assert.match(sql, /bump_admin_session_version_by_auth_user/i);
  assert.match(sql, /grant execute[\s\S]*service_role/i);
});

test(
  "integração DB Etapa 4: guard bloqueia, sucesso limpa e RPC de versão existe",
  { skip: process.env.RUN_ADMIN_STEP4_DB_TESTS !== "1" },
  async () => {
    const identityHash = crypto.randomBytes(32).toString("hex");

    try {
      const adminColumnProbe = await supabaseAdmin
        .from("admins")
        .select("id,session_version")
        .limit(1);
      assert.equal(adminColumnProbe.error, null, adminColumnProbe.error?.message);

      const sessionColumnProbe = await supabaseAdmin
        .from("admin_sessions")
        .select("id,session_version")
        .limit(1);
      assert.equal(sessionColumnProbe.error, null, sessionColumnProbe.error?.message);

      const initial = await supabaseAdmin.rpc("admin_login_guard_status", {
        p_identity_hash: identityHash,
      });
      assert.equal(initial.error, null, initial.error?.message);
      assert.equal(initial.data?.[0]?.blocked, false);

      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const result = await supabaseAdmin.rpc("admin_login_guard_failure", {
          p_identity_hash: identityHash,
          p_max_attempts: 3,
          p_window_seconds: 60,
          p_block_seconds: 60,
        });
        assert.equal(result.error, null, result.error?.message);
        assert.equal(Number(result.data?.[0]?.failed_attempts), attempt);
        if (attempt < 3) assert.equal(result.data?.[0]?.blocked, false);
        if (attempt === 3) {
          assert.equal(result.data?.[0]?.blocked, true);
          assert.ok(Number(result.data?.[0]?.retry_after_seconds) > 0);
        }
      }

      const success = await supabaseAdmin.rpc("admin_login_guard_success", {
        p_identity_hash: identityHash,
      });
      assert.equal(success.error, null, success.error?.message);

      const afterSuccess = await supabaseAdmin.rpc("admin_login_guard_status", {
        p_identity_hash: identityHash,
      });
      assert.equal(afterSuccess.error, null, afterSuccess.error?.message);
      assert.equal(afterSuccess.data?.[0]?.blocked, false);
      assert.equal(Number(afterSuccess.data?.[0]?.failed_attempts), 0);

      const noOpVersionBump = await supabaseAdmin.rpc(
        "bump_admin_session_version_by_auth_user",
        { p_auth_user_id: crypto.randomUUID() }
      );
      assert.equal(noOpVersionBump.error, null, noOpVersionBump.error?.message);
      assert.deepEqual(noOpVersionBump.data, []);
    } finally {
      const cleanup = await supabaseAdmin
        .from("admin_login_guard")
        .delete()
        .eq("identity_hash", identityHash);
      assert.equal(cleanup.error, null, cleanup.error?.message);
    }
  }
);
