import express from "express";
import jwt from "jsonwebtoken";

import { supabaseAdmin, supabaseAuth } from "../config/supabase.js";
import { env } from "../config/env.js";
import { recordAuditLog } from "../services/audit.service.js";
import { getAdminPermissions } from "../repositories/permission.repository.js";
import { isMasterAdmin } from "../services/permissions/permission.service.js";

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

  if (value.length < 8) {
    return "A nova senha precisa ter pelo menos 8 caracteres.";
  }

  if (confirm && value !== confirm) {
    return "As senhas não conferem.";
  }

  return null;
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

    return res.status(200).json({
      success: true,
      message: "Senha redefinida com sucesso. Faça login novamente.",
    });
  } catch (error) {
    console.error("[ADMIN_RESET_PASSWORD_ERROR]", {
      message: error?.message,
      name: error?.name,
    });

    return res.status(500).json({
      success: false,
      message: "Erro ao redefinir senha.",
    });
  }
});

router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      recordLoginAuditSafely({ req, email, status: "failure", reason: "missing_credentials" });
      return res.status(400).json({
        success: false,
        message: "E-mail e senha são obrigatórios",
      });
    }

    const normalizedEmail = normalizeEmail(email);

    const { data: authData, error: authError } =
      await supabaseAuth.auth.signInWithPassword({
        email: normalizedEmail,
        password,
      });

    if (authError || !authData?.user) {
      recordLoginAuditSafely({ req, email: normalizedEmail, status: "failure", reason: "invalid_credentials" });
      console.warn("[ADMIN_LOGIN_AUTH_ERROR]", {
        email: maskEmail(normalizedEmail),
        message: authError?.message,
        status: authError?.status,
      });

      return res.status(401).json({
        success: false,
        message: "Credenciais inválidas",
      });
    }

    const adminLookup = await findAdminByEmail(normalizedEmail);

    if (!adminLookup.ok) {
      recordLoginAuditSafely({ req, email: normalizedEmail, status: "failure", reason: "admin_lookup_failed" });
      console.error("[ADMIN_LOGIN_LOOKUP_ERROR]", {
        email: maskEmail(normalizedEmail),
        status: adminLookup.status,
      });

      return res.status(500).json({
        success: false,
        message: "Erro ao consultar admins",
      });
    }

    const admin = Array.isArray(adminLookup.data)
      ? adminLookup.data[0]
      : adminLookup.data;

    if (!admin) {
      recordLoginAuditSafely({ req, email: normalizedEmail, status: "failure", reason: "no_panel_access" });
      console.warn("[ADMIN_LOGIN_NO_PANEL_ACCESS]", {
        email: maskEmail(normalizedEmail),
      });

      return res.status(403).json({
        success: false,
        message: "Usuário autenticado, mas sem acesso ao painel",
      });
    }

    if (!admin.is_active) {
      recordLoginAuditSafely({ req, admin, email: normalizedEmail, status: "failure", reason: "inactive_admin" });
      console.warn("[ADMIN_LOGIN_INACTIVE]", {
        email: maskEmail(normalizedEmail),
        admin_id: admin.id,
      });

      return res.status(403).json({
        success: false,
        message: "Usuário inativo no painel administrativo",
      });
    }

    recordLoginAuditSafely({ req, admin, email: normalizedEmail, status: "success" });

    const token = jwt.sign(
      {
        sub: authData.user.id,
        admin_id: admin.id,
        email: admin.email,
        role: admin.role,
        supabase_access_token: authData.session?.access_token || null,
      },
      env.jwtSecret,
      { expiresIn: "8h" }
    );

    return res.status(200).json({
      success: true,
      message: "Login realizado com sucesso",
      token,
      user: {
        id: admin.id,
        full_name: admin.full_name,
        email: admin.email,
        role: admin.role,
        is_master: admin.is_master,
      },
      session: {
        access_token: authData.session?.access_token || null,
        refresh_token: authData.session?.refresh_token || null,
        expires_at: authData.session?.expires_at || null,
      },
    });
  } catch (error) {
    recordLoginAuditSafely({
      req,
      email: req.body?.email,
      status: "failure",
      reason: "unexpected_login_error",
    });

    console.error("[ADMIN_LOGIN_ERROR]", {
      message: error?.message,
      name: error?.name,
    });

    return res.status(500).json({
      success: false,
      message: "Erro ao realizar login",
    });
  }
});

router.get("/me", async (req, res) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        message: "Token não enviado",
      });
    }

    const token = authHeader.split(" ")[1];
    const decoded = jwt.verify(token, env.jwtSecret);

    if (!decoded.supabase_access_token) {
      return res.status(401).json({
        success: false,
        message: "Sessão Supabase ausente",
      });
    }

    const { data: userData, error: userError } =
      await supabaseAuth.auth.getUser(decoded.supabase_access_token);

    if (userError || !userData?.user) {
      console.warn("[ADMIN_ME_SUPABASE_SESSION_ERROR]", {
        message: userError?.message,
        status: userError?.status,
      });

      return res.status(401).json({
        success: false,
        message: "Sessão inválida ou expirada",
      });
    }

    const normalizedEmail = String(userData.user.email || "")
      .trim()
      .toLowerCase();

    const adminLookup = await findAdminByEmail(normalizedEmail);

    console.info("[ADMIN_ME_LOOKUP]", {
      status: adminLookup.status,
      email: maskEmail(normalizedEmail),
    });

    if (!adminLookup.ok) {
      console.error("[ADMIN_LOGIN_LOOKUP_ERROR]", {
        email: maskEmail(normalizedEmail),
        status: adminLookup.status,
      });

      return res.status(500).json({
        success: false,
        message: "Erro ao consultar admins",
      });
    }

    const admin = Array.isArray(adminLookup.data)
      ? adminLookup.data[0]
      : adminLookup.data;

    if (!admin) {
      return res.status(403).json({
        success: false,
        message: "Usuário sem acesso ao painel",
      });
    }

    if (!admin.is_active) {
      return res.status(403).json({
        success: false,
        message: "Usuário inativo",
      });
    }

    // Garante que is_master esteja presente mesmo se a RPC não retornar
    const isMaster = admin.is_master === true;

    return res.status(200).json({
      success: true,
      user: {
        ...admin,
        is_master: isMaster,
      },
    });
  } catch (error) {
    console.warn("[ADMIN_ME_TOKEN_ERROR]", {
      message: error?.message,
      name: error?.name,
    });

    return res.status(401).json({
      success: false,
      message: "Token inválido ou expirado",
    });
  }
});

export default router;