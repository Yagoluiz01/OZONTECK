import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  getAdminSessionCookieName,
  getAdminSessionCookieOptions,
  setAdminSessionCookie,
  clearAdminSessionCookie,
  getAdminSessionTokenFromRequest,
  assertAdminCsrfProtection,
  createAdminSession,
  getAdminSessionCsrfToken,
  validateAdminSessionToken,
  revokeAdminSessionToken,
} from '../services/adminSession.service.js';
import { supabaseAdmin } from '../config/supabase.js';

test('cookie administrativo tem atributos seguros', () => {
  const options = getAdminSessionCookieOptions();
  assert.equal(options.httpOnly, true);
  assert.equal(options.path, '/');

  if (process.env.NODE_ENV === 'production') {
    assert.equal(getAdminSessionCookieName(), '__Host-oz_admin_session');
    assert.equal(options.secure, true);
  }
});

test('cookie pode ser gravado, lido e limpo', () => {
  const calls = [];
  const res = {
    cookie: (...args) => calls.push(['cookie', ...args]),
    clearCookie: (...args) => calls.push(['clear', ...args]),
  };

  setAdminSessionCookie(res, 'opaque-session-test-token');
  assert.equal(calls[0][0], 'cookie');
  assert.equal(calls[0][2], 'opaque-session-test-token');
  assert.equal(calls[0][3].httpOnly, true);

  const cookieName = getAdminSessionCookieName();
  const req = { headers: { cookie: `${cookieName}=abc%20123; foo=bar` } };
  assert.equal(getAdminSessionTokenFromRequest(req), 'abc 123');

  clearAdminSessionCookie(res);
  assert.ok(calls.some((entry) => entry[0] === 'clear'));
});

test('CSRF aceita origem/token corretos e bloqueia ataques', () => {
  const csrfToken = 'csrf-test-token-with-enough-entropy';
  const session = {
    csrf_token_hash: crypto.createHash('sha256').update(csrfToken).digest('hex'),
  };

  const allowedOrigin = process.env.ADMIN_FRONTEND_URL || 'https://ozonteck-admin.onrender.com';
  const makeReq = ({ method = 'POST', origin = allowedOrigin, token = csrfToken } = {}) => ({
    method,
    headers: { origin, 'x-csrf-token': token },
    get(name) {
      return this.headers[String(name).toLowerCase()] || '';
    },
  });

  assert.doesNotThrow(() => assertAdminCsrfProtection(makeReq(), session));
  assert.doesNotThrow(() =>
    assertAdminCsrfProtection(makeReq({ method: 'GET', origin: 'https://evil.invalid' }), session)
  );

  assert.throws(
    () => assertAdminCsrfProtection(makeReq({ origin: 'https://evil.invalid' }), session),
    (error) => error?.statusCode === 403 && error?.code === 'ADMIN_CSRF_ORIGIN_REJECTED'
  );

  assert.throws(
    () => assertAdminCsrfProtection(makeReq({ token: 'wrong-token' }), session),
    (error) => error?.statusCode === 403 && error?.code === 'ADMIN_CSRF_TOKEN_INVALID'
  );

  assert.throws(
    () => assertAdminCsrfProtection(makeReq({ token: '' }), session),
    (error) => error?.statusCode === 403 && error?.code === 'ADMIN_CSRF_TOKEN_MISSING'
  );
});

test(
  'integração DB: cria, valida, revoga e remove sessão temporária',
  { skip: process.env.RUN_ADMIN_SESSION_DB_TESTS !== '1' },
  async () => {
    let createdSessionId = null;

    try {
      const probe = await supabaseAdmin
        .from('admin_sessions')
        .select('id')
        .limit(1);
      assert.equal(probe.error, null, probe.error?.message);

      const adminLookup = await supabaseAdmin
        .from('admins')
        .select('id,email,role,is_active,is_master,auth_user_id')
        .eq('is_active', true)
        .limit(1)
        .maybeSingle();

      assert.equal(adminLookup.error, null, adminLookup.error?.message);
      assert.ok(adminLookup.data?.id, 'Nenhum admin ativo disponível para o teste');

      const req = {
        ip: '203.0.113.10',
        headers: { 'user-agent': 'ozonteck-security-test/1.0' },
        get(name) {
          return this.headers[String(name).toLowerCase()] || '';
        },
        socket: { remoteAddress: '203.0.113.10' },
      };

      const created = await createAdminSession({
        req,
        admin: adminLookup.data,
        authUserId: adminLookup.data.auth_user_id || null,
      });

      createdSessionId = created.session.id;
      assert.ok(created.token.length >= 40);
      assert.ok(created.csrfToken.length >= 32);

      const expectedTokenHash = crypto
        .createHash('sha256')
        .update(created.token, 'utf8')
        .digest('hex');

      const row = await supabaseAdmin
        .from('admin_sessions')
        .select('id,token_hash,csrf_token_hash,revoked_at')
        .eq('id', createdSessionId)
        .single();

      assert.equal(row.error, null, row.error?.message);
      assert.equal(row.data.token_hash, expectedTokenHash);
      assert.notEqual(row.data.token_hash, created.token);
      assert.notEqual(row.data.csrf_token_hash, created.csrfToken);
      assert.equal(row.data.revoked_at, null);

      const validated = await validateAdminSessionToken(created.token, { req });
      assert.equal(validated.id, createdSessionId);

      const rehydratedCsrf = await getAdminSessionCsrfToken(createdSessionId);
      assert.equal(rehydratedCsrf.csrfToken, created.csrfToken);

      assert.equal(await revokeAdminSessionToken(created.token, 'automated_test'), true);

      await assert.rejects(
        () => validateAdminSessionToken(created.token, { req }),
        (error) => error?.statusCode === 401
      );
    } finally {
      if (createdSessionId) {
        const cleanup = await supabaseAdmin
          .from('admin_sessions')
          .delete()
          .eq('id', createdSessionId);

        assert.equal(cleanup.error, null, cleanup.error?.message);
      }
    }
  }
);
