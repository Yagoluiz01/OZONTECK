import express from "express";
import { supabaseAdmin, supabaseAuth } from "../config/supabase.js";
import { env } from "../config/env.js";
import { recordAuditLog } from "../services/audit.service.js";
import { getAdminPermissions } from "../repositories/permission.repository.js";
import { isMasterAdmin } from "../services/permissions/permission.service.js";
import { requireAdminAuth } from "../middlewares/auth.middleware.js";
import {
  clearAdminSessionCookie,
  createAdminSession,
  getAdminSessionTokenFromRequest,
  revokeAdminSessionToken,
  revokeAllAdminSessions,
  getAdminSessionCsrfToken,
  invalidateAdminSessionsAfterPasswordReset,
  setAdminSessionCookie,
} from "../services/adminSession.service.js";
import {
  checkAdminLoginGuard,
  enforceMinimumAdminLoginDuration,
  registerAdminLoginFailure,
  registerAdminLoginSuccess,
  setLoginRetryAfter,
} from "../services/adminLoginGuard.service.js";
import { recordAdminLoginSecurityAttempt } from "../services/adminIntrusionDetection.service.js";

const router = express.Router();



async function findAdminByEmail(email) {
  const response = await fetch(`${env.supabaseUrl}/rest/v1/rpc/get_admin_by_email`, {
    method: "POST",
    headers: {
      apikey: env.supabaseServiceRoleKey,
      Authorization: `Bearer ${env.supabaseServiceRoleKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      p_email: email,
    }),
  });

  const text = await response.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  return {
    ok: response.ok,
    status: response.status,
    data,
  };
}


function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function maskEmail(value) {
  const email = normalizeEmail(value);
  const [name, domain] = email.split("@");

  if (!name || !domain) {
    return "e-mail inválido";
  }

  return `${name.slice(0, 2)}***@${domain}`;
}


function recordLoginAuditSafely({ req, admin = null, email = null, status = "success", reason = null }) {
  const normalizedEmail = normalizeEmail(admin?.email || email);
  const actor = admin
    ? {
        id: admin.id || null,
        userId: admin.user_id || admin.userId || admin.auth_user_id || null,
        email: admin.email || normalizedEmail || null,
        full_name: admin.full_name || admin.name || null,
        role: admin.role || null,
      }
    : {
        id: null,
        userId: null,
        email: normalizedEmail || null,
        full_name: null,
        role: null,
      };

  setImmediate(() => {
    recordAuditLog({
      req,
      actor,
      action: status === "success" ? "admin_login_success" : "admin_login_failure",
      module: "security",
      entityType: "admin_session",
      entityId: admin?.id || null,
      description:
        status === "success"
          ? `${admin?.full_name || admin?.email || "Administrador"} entrou no painel administrativo.`
          : `Tentativa de login administrativo falhou para ${maskEmail(normalizedEmail)}.`,
      metadata: {
        reason: reason || null,
        attempted_email: maskEmail(normalizedEmail),
      },
      status,
    }).catch((error) => {
      console.error("[ADMIN_LOGIN_AUDIT_ERROR]", {
        status,
        message: error?.message || String(error),
      });
    });
  });
}

function getAdminPasswordResetRedirectUrl() {
  const explicitRedirect = String(process.env.ADMIN_PASSWORD_RESET_REDIRECT_URL || "").trim();

  if (explicitRedirect) {
    return explicitRedirect;
  }

  const adminUrl = String(
    process.env.ADMIN_FRONTEND_URL ||
      process.env.ADMIN_URL ||
      "https://ozonteck-admin.onrender.com"
  )
    .trim()
    .replace(/\/+$/, "");

  return `${adminUrl}/reset-password`;
}

function getRecoverySuccessMessage() {
  return "Se este e-mail estiver liberado como administrador, enviaremos um link de recuperação em alguns minutos.";
}

async function sendAdminRecoveryEmail(email) {
  const redirectTo = getAdminPasswordResetRedirectUrl();

  if (typeof supabaseAdmin?.auth?.resetPasswordForEmail === "function") {
    return supabaseAdmin.auth.resetPasswordForEmail(email, { redirectTo });
  }

  if (typeof supabaseAuth?.auth?.resetPasswordForEmail === "function") {
    return supabaseAuth.auth.resetPasswordForEmail(email, { redirectTo });
  }

  return {
    data: null,
    error: new Error("Cliente Supabase não suporta resetPasswordForEmail."),
  };
}

function normalizeRecoveryToken(value) {
  return String(value || "").trim();
}

function validateAdminResetPassword(password, confirmPassword) {
  const value = String(password || "");
  const confirm = String(confirmPassword || "");

  if (!value) {
    return "Nova senha é obrigatória.";
  }

  if (value.length < 15) {
    return "A nova senha precisa ter pelo menos 15 caracteres.";
  }

  if (value.length > 128) {
    return "A nova senha pode ter no máximo 128 caracteres.";
  }

  if (confirm && value !== confirm) {
    return "As senhas não conferem.";
  }

  return null;
}

async function getSupabaseUserFromAccessToken(accessToken) {
  const response = await fetch(`${env.supabaseUrl}/auth/v1/user`, {
    method: "GET",
    headers: {
      apikey: env.supabaseServiceRoleKey,
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  const text = await response.text();
  let data = null;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  return {
    ok: response.ok,
    status: response.status,
    data,
  };
}

async function updateSupabaseUserPassword(accessToken, password) {
  const response = await fetch(`${env.supabaseUrl}/auth/v1/user`, {
    method: "PUT",
    headers: {
      apikey: env.supabaseServiceRoleKey,
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      password,
    }),
  });

  const text = await response.text();

  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  return {
    ok: response.ok,
    status: response.status,
    data,
  };
}


router.post("/forgot-password", async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);

    if (!email || !email.includes("@")) {
      return res.status(400).json({
        success: false,
        message: "Informe um e-mail válido.",
      });
    }

    const successMessage = getRecoverySuccessMessage();
    const adminLookup = await findAdminByEmail(email);

    if (!adminLookup.ok) {
      console.warn("[ADMIN_FORGOT_PASSWORD_LOOKUP_ERROR]", {
        status: adminLookup.status,
        email: maskEmail(email),
      });

      return res.status(500).json({
        success: false,
        message: "Não foi possível verificar o acesso administrativo agora.",
      });
    }

    const admin = Array.isArray(adminLookup.data) ? adminLookup.data[0] : adminLookup.data;

    // Resposta genérica para não revelar se um e-mail existe ou não no painel.
    if (!admin || admin.is_active === false) {
      console.info("[ADMIN_FORGOT_PASSWORD_IGNORED]", {
        reason: admin ? "inactive_admin" : "admin_not_found",
        email: maskEmail(email),
      });

      return res.status(200).json({
        success: true,
        message: successMessage,
      });
    }

    const { error: recoveryError } = await sendAdminRecoveryEmail(email);

    if (recoveryError) {
      console.error("[ADMIN_FORGOT_PASSWORD_SEND_ERROR]", {
        email: maskEmail(email),
        message: recoveryError.message,
        status: recoveryError.status,
        name: recoveryError.name,
      });

      return res.status(502).json({
        success: false,
        message: "Não foi possível enviar o e-mail de recuperação. Verifique o SMTP do Supabase/Brevo.",
      });
    }

    console.info("[ADMIN_FORGOT_PASSWORD_SENT]", {
      email: maskEmail(email),
      redirectTo: getAdminPasswordResetRedirectUrl(),
    });

    return res.status(200).json({
      success: true,
      message: successMessage,
    });
  } catch (error) {
    console.error("[ADMIN_FORGOT_PASSWORD_ERROR]", {
      message: error?.message,
      name: error?.name,
    });

    return res.status(500).json({
      success: false,
      message: "Erro ao solicitar recuperação de senha.",
    });
  }
});

router.post("/reset-password", async (req, res) => {
  try {
    const accessToken = normalizeRecoveryToken(
      req.body?.access_token ||
        req.body?.accessToken ||
        req.body?.token ||
        req.headers?.authorization?.replace(/^Bearer\s+/i, "")
    );

    const password = String(req.body?.password || req.body?.new_password || "");
    const confirmPassword = String(
      req.body?.confirm_password || req.body?.confirmPassword || req.body?.password_confirm || ""
    );

    if (!accessToken) {
      return res.status(400).json({
        success: false,
        message: "Token de recuperação não enviado. Solicite um novo link de redefinição de senha.",
      });
    }

    const passwordError = validateAdminResetPassword(password, confirmPassword);
    if (passwordError) {
      return res.status(400).json({
        success: false,
        message: passwordError,
      });
    }

    const recoveryUserResult = await getSupabaseUserFromAccessToken(accessToken);

    if (!recoveryUserResult.ok || !recoveryUserResult.data?.id) {
      return res.status(401).json({
        success: false,
        message: "Link de recuperação inválido ou expirado. Solicite um novo e-mail de recuperação.",
      });
    }

    const recoveryUserEmail = normalizeEmail(recoveryUserResult.data?.email);
    const recoveryAdminLookup = await findAdminByEmail(recoveryUserEmail);
    const recoveryAdmin = Array.isArray(recoveryAdminLookup.data)
      ? recoveryAdminLookup.data[0]
      : recoveryAdminLookup.data;

    if (
      !recoveryAdminLookup.ok ||
      !recoveryAdmin ||
      recoveryAdmin.is_active !== true ||
      (recoveryAdmin.auth_user_id &&
        String(recoveryAdmin.auth_user_id) !== String(recoveryUserResult.data.id))
    ) {
      console.warn("[ADMIN_RESET_PASSWORD_ACCESS_REJECTED]", {
        auth_user_id: recoveryUserResult.data?.id || null,
        email: maskEmail(recoveryUserEmail),
      });
      return res.status(401).json({
        success: false,
        message: "Link de recuperação inválido ou expirado. Solicite um novo e-mail de recuperação.",
      });
    }

    const updateResult = await updateSupabaseUserPassword(accessToken, password);

    if (!updateResult.ok) {
      console.warn("[ADMIN_RESET_PASSWORD_SUPABASE_ERROR]", {
        status: updateResult.status,
        message:
          typeof updateResult.data === "object"
            ? updateResult.data?.message || updateResult.data?.msg || updateResult.data?.error_description
            : String(updateResult.data || "").slice(0, 180),
      });

      const supabaseMessage =
        typeof updateResult.data === "object"
          ? updateResult.data?.msg || updateResult.data?.message || updateResult.data?.error_description
          : String(updateResult.data || "");

      return res.status(updateResult.status === 401 || updateResult.status === 403 ? 401 : 400).json({
        success: false,
        message:
          supabaseMessage ||
          "Link de recuperação inválido ou expirado. Solicite um novo e-mail de recuperação.",
      });
    }

    const updatedAuthUserId = String(recoveryUserResult.data.id).trim();
    await invalidateAdminSessionsAfterPasswordReset(updatedAuthUserId);
    clearAdminSessionCookie(res);

    return res.status(200).json({
      success: true,
      message: "Senha redefinida com sucesso. Todas as sessões anteriores foram encerradas.",
    });
  } catch (error) {
    console.error("[ADMIN_RESET_PASSWORD_ERROR]", {
      message: error?.message,
      name: error?.name,
      code: error?.code,
    });

    const statusCode = Number(error?.statusCode || 500);
    if (String(error?.code || "").startsWith("ADMIN_SESSION_PASSWORD_RESET_")) {
      clearAdminSessionCookie(res);
    }

    return res.status(statusCode).json({
      success: false,
      message:
        statusCode === 503
          ? "A senha foi alterada, mas não foi possível concluir a invalidação de segurança. Tente recuperar a senha novamente antes de entrar."
          : "Erro ao redefinir senha.",
    });
  }
});

router.post("/login", async (req, res) => {
  const startedAtMs = Date.now();
  const normalizedEmail = normalizeEmail(req.body?.email);
  const password = String(req.body?.password || "");

  async function respondCredentialFailure({ reason, admin = null, statusCode = 401 }) {
    let guardResult = null;

    try {
      guardResult = await registerAdminLoginFailure(normalizedEmail);
    } catch (guardError) {
      console.error("[ADMIN_LOGIN_GUARD_RECORD_FAILURE]", {
        message: guardError?.message || String(guardError),
      });
      await enforceMinimumAdminLoginDuration(startedAtMs);
      return res.status(503).json({
        success: false,
        message: "Não foi possível validar o acesso administrativo agora. Tente novamente.",
      });
    }

    recordLoginAuditSafely({
      req,
      admin,
      email: normalizedEmail,
      status: "failure",
      reason,
    });

    recordAdminLoginSecurityAttempt({
      req,
      email: normalizedEmail,
      admin,
      success: false,
      reason,
      rateLimited: guardResult?.blocked === true,
    });

    await enforceMinimumAdminLoginDuration(startedAtMs);

    if (guardResult?.blocked) {
      setLoginRetryAfter(res, guardResult.retryAfterSeconds);
      return res.status(429).json({
        success: false,
        message: "Muitas tentativas de acesso. Aguarde alguns minutos e tente novamente.",
      });
    }

    return res.status(statusCode).json({
      success: false,
      message: "Credenciais inválidas",
    });
  }

  try {
    if (!normalizedEmail || !password) {
      recordLoginAuditSafely({
        req,
        email: normalizedEmail,
        status: "failure",
        reason: "missing_credentials",
      });
      await enforceMinimumAdminLoginDuration(startedAtMs);
      return res.status(400).json({
        success: false,
        message: "E-mail e senha são obrigatórios",
      });
    }

    let guardStatus;
    try {
      guardStatus = await checkAdminLoginGuard(normalizedEmail);
    } catch (guardError) {
      console.error("[ADMIN_LOGIN_GUARD_CHECK_FAILED]", {
        message: guardError?.message || String(guardError),
      });
      await enforceMinimumAdminLoginDuration(startedAtMs);
      return res.status(503).json({
        success: false,
        message: "Não foi possível validar o acesso administrativo agora. Tente novamente.",
      });
    }

    if (guardStatus.blocked) {
      recordLoginAuditSafely({
        req,
        email: normalizedEmail,
        status: "failure",
        reason: "rate_limited_account",
      });
      recordAdminLoginSecurityAttempt({
        req,
        email: normalizedEmail,
        success: false,
        reason: "rate_limited_account",
        rateLimited: true,
      });
      await enforceMinimumAdminLoginDuration(startedAtMs);
      setLoginRetryAfter(res, guardStatus.retryAfterSeconds);
      return res.status(429).json({
        success: false,
        message: "Muitas tentativas de acesso. Aguarde alguns minutos e tente novamente.",
      });
    }

    const { data: authData, error: authError } =
      await supabaseAuth.auth.signInWithPassword({
        email: normalizedEmail,
        password,
      });

    if (authError || !authData?.user) {
      console.warn("[ADMIN_LOGIN_AUTH_ERROR]", {
        email: maskEmail(normalizedEmail),
        message: authError?.message,
        status: authError?.status,
      });

      return respondCredentialFailure({ reason: "invalid_credentials" });
    }

    const adminLookup = await findAdminByEmail(normalizedEmail);

    if (!adminLookup.ok) {
      recordLoginAuditSafely({
        req,
        email: normalizedEmail,
        status: "failure",
        reason: "admin_lookup_failed",
      });
      console.error("[ADMIN_LOGIN_LOOKUP_ERROR]", {
        email: maskEmail(normalizedEmail),
        status: adminLookup.status,
      });

      await enforceMinimumAdminLoginDuration(startedAtMs);
      return res.status(503).json({
        success: false,
        message: "Não foi possível validar o acesso administrativo agora. Tente novamente.",
      });
    }

    const admin = Array.isArray(adminLookup.data)
      ? adminLookup.data[0]
      : adminLookup.data;

    // Não diferenciamos "conta não é admin" de "senha inválida" para reduzir
    // enumeração de contas e vazamento de estado administrativo.
    if (!admin) {
      console.warn("[ADMIN_LOGIN_NO_PANEL_ACCESS]", {
        email: maskEmail(normalizedEmail),
      });
      return respondCredentialFailure({ reason: "no_panel_access" });
    }

    if (!admin.is_active) {
      console.warn("[ADMIN_LOGIN_INACTIVE]", {
        email: maskEmail(normalizedEmail),
        admin_id: admin.id,
      });
      return respondCredentialFailure({
        reason: "inactive_admin",
        admin,
      });
    }

    // Limpa o contador de falhas ANTES de emitir a sessão. Se esse controle
    // persistente estiver indisponível, o login falha fechado e nenhuma sessão nasce.
    await registerAdminLoginSuccess(normalizedEmail);

    const adminIsMaster = isMasterAdmin(admin);
    const adminPermissions = adminIsMaster ? [] : await getAdminPermissions(admin.id);

    const { token: opaqueSessionToken, csrfToken, session: opaqueSession } =
      await createAdminSession({
        req,
        admin,
        authUserId: authData.user.id,
      });

    setAdminSessionCookie(res, opaqueSessionToken);
    recordLoginAuditSafely({
      req,
      admin,
      email: normalizedEmail,
      status: "success",
    });
    recordAdminLoginSecurityAttempt({
      req,
      email: normalizedEmail,
      admin,
      success: true,
      reason: "success",
      rateLimited: false,
    });

    return res.status(200).json({
      success: true,
      message: "Login realizado com sucesso",
      user: {
        id: admin.id,
        full_name: admin.full_name,
        email: admin.email,
        role: admin.role,
        is_master: admin.is_master,
        permissions: adminPermissions,
      },
      secure_session: {
        id: opaqueSession.id,
        expires_at: opaqueSession.expires_at,
        idle_expires_at: opaqueSession.idle_expires_at,
        csrf_token: csrfToken,
      },
    });
  } catch (error) {
    recordLoginAuditSafely({
      req,
      email: normalizedEmail,
      status: "failure",
      reason: "unexpected_login_error",
    });

    console.error("[ADMIN_LOGIN_ERROR]", {
      message: error?.message,
      name: error?.name,
      code: error?.code,
    });

    await enforceMinimumAdminLoginDuration(startedAtMs);

    const statusCode = Number(error?.statusCode || 500);
    return res.status(statusCode).json({
      success: false,
      message:
        statusCode === 503
          ? "Não foi possível iniciar uma sessão segura agora. Tente novamente."
          : "Erro ao realizar login",
    });
  }
});

router.post("/logout", requireAdminAuth, async (req, res) => {
  const sessionToken = getAdminSessionTokenFromRequest(req);

  try {
    if (sessionToken) {
      await revokeAdminSessionToken(sessionToken, "logout");
    }

    clearAdminSessionCookie(res);

    return res.status(200).json({
      success: true,
      message: "Sessão encerrada com sucesso.",
    });
  } catch (error) {
    // Mesmo se o banco estiver temporariamente indisponível, removemos o cookie local.
    // A revogação no servidor é fail-closed nas rotas autenticadas quando o banco volta.
    clearAdminSessionCookie(res);

    console.error("[ADMIN_LOGOUT_ERROR]", {
      message: error?.message || String(error),
    });

    return res.status(Number(error?.statusCode || 503)).json({
      success: false,
      message: "Não foi possível concluir a revogação da sessão agora.",
    });
  }
});

router.post("/logout-all", requireAdminAuth, async (req, res) => {
  try {
    const revoked = await revokeAllAdminSessions(req.admin.id, "logout_all");
    clearAdminSessionCookie(res);

    return res.status(200).json({
      success: true,
      message: "Todas as sessões administrativas foram encerradas.",
      revoked_sessions: revoked,
    });
  } catch (error) {
    console.error("[ADMIN_LOGOUT_ALL_ERROR]", {
      admin_id: req.admin?.id || null,
      message: error?.message || String(error),
    });

    return res.status(Number(error?.statusCode || 503)).json({
      success: false,
      message: "Não foi possível encerrar todas as sessões agora.",
    });
  }
});

router.get("/me", requireAdminAuth, async (req, res) => {
  try {
    const adminLookup = await findAdminByEmail(req.admin.email);

    if (!adminLookup.ok) {
      console.error("[ADMIN_ME_LOOKUP_ERROR]", {
        admin_id: req.admin.id,
        status: adminLookup.status,
      });

      return res.status(503).json({
        success: false,
        message: "Não foi possível consultar o administrador agora.",
      });
    }

    const admin = Array.isArray(adminLookup.data)
      ? adminLookup.data[0]
      : adminLookup.data;

    if (!admin || !admin.is_active) {
      return res.status(403).json({
        success: false,
        message: "Usuário sem acesso ativo ao painel.",
      });
    }

    const adminIsMaster = isMasterAdmin(admin);
    const adminPermissions = adminIsMaster ? [] : await getAdminPermissions(admin.id);

    let secureSession = null;
    if (req.adminAuth?.mode === "opaque_session" && req.adminAuth?.sessionId) {
      const rotated = await getAdminSessionCsrfToken(req.adminAuth.sessionId);
      secureSession = {
        id: rotated.session.id,
        expires_at: rotated.session.expires_at,
        idle_expires_at: rotated.session.idle_expires_at,
        csrf_token: rotated.csrfToken,
      };
    }

    return res.status(200).json({
      success: true,
      auth_mode: req.adminAuth?.mode || "unknown",
      ...(secureSession ? { secure_session: secureSession } : {}),
      user: {
        ...admin,
        is_master: adminIsMaster,
        permissions: adminPermissions,
      },
    });
  } catch (error) {
    console.error("[ADMIN_ME_ERROR]", {
      admin_id: req.admin?.id || null,
      message: error?.message || String(error),
    });

    return res.status(500).json({
      success: false,
      message: "Erro ao consultar a sessão administrativa.",
    });
  }
});

export default router;