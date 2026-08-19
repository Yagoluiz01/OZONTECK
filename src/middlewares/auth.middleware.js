import { supabaseAdmin } from "../config/supabase.js";
import {
  assertAdminCsrfProtection,
  clearAdminSessionCookie,
  getAdminSessionTokenFromRequest,
  revokeAdminSessionId,
  validateAdminSessionToken,
} from "../services/adminSession.service.js";

async function loadActiveAdmin(identity) {
  const adminId = identity?.admin_id;

  if (!adminId) {
    const identityError = new Error("Sessão administrativa inválida.");
    identityError.statusCode = 401;
    throw identityError;
  }

  const { data, error } = await supabaseAdmin
    .from("admins")
    .select(`
id,
full_name,
email,
role,
is_active,
is_master,
auth_user_id,
session_version
`)
    .eq("id", adminId)
    .maybeSingle();

  if (error) {
    console.error("[ADMIN_AUTH_DATABASE_ERROR]", {
      admin_id: adminId,
      message: error.message,
    });

    const databaseError = new Error("Não foi possível validar a sessão administrativa.");
    databaseError.statusCode = 503;
    throw databaseError;
  }

  if (!data || data.is_active !== true) {
    const inactiveError = new Error("Acesso administrativo desativado ou removido.");
    inactiveError.statusCode = 403;
    throw inactiveError;
  }

  if (
    data.auth_user_id &&
    identity?.auth_user_id &&
    String(data.auth_user_id) !== String(identity.auth_user_id)
  ) {
    const identityError = new Error("Sessão administrativa inválida.");
    identityError.statusCode = 401;
    throw identityError;
  }

  return data;
}

function attachAdmin(req, currentAdmin, session) {
  req.admin = {
    id: currentAdmin.id,
    userId: currentAdmin.auth_user_id || session?.auth_user_id || null,
    email: currentAdmin.email,
    fullName: currentAdmin.full_name || null,
    role: currentAdmin.role,
    is_master: currentAdmin.is_master,
  };

  req.adminAuth = {
    mode: "opaque_session",
    sessionId: session?.id || null,
  };
}

export async function requireAdminAuth(req, res, next) {
  const sessionToken = getAdminSessionTokenFromRequest(req);

  if (!sessionToken) {
    return res.status(401).json({
      success: false,
      message: "Sessão administrativa não enviada.",
    });
  }

  try {
    const session = await validateAdminSessionToken(sessionToken, { req });
    assertAdminCsrfProtection(req, session);

    const currentAdmin = await loadActiveAdmin({
      admin_id: session.admin_id,
      auth_user_id: session.auth_user_id,
    });

    const sessionVersion = Number(session?.session_version || 0);
    const currentSessionVersion = Number(currentAdmin?.session_version || 0);

    if (
      !Number.isSafeInteger(sessionVersion) ||
      !Number.isSafeInteger(currentSessionVersion) ||
      sessionVersion < 1 ||
      currentSessionVersion < 1 ||
      sessionVersion !== currentSessionVersion
    ) {
      await revokeAdminSessionId(session.id, "session_version_mismatch");
      const versionError = new Error(
        "A sessão administrativa foi invalidada por uma alteração de segurança."
      );
      versionError.statusCode = 401;
      versionError.code = "ADMIN_SESSION_VERSION_MISMATCH";
      throw versionError;
    }

    attachAdmin(req, currentAdmin, session);
    return next();
  } catch (error) {
    const statusCode = Number(error?.statusCode || 401);
    const isCsrfError = String(error?.code || "").startsWith("ADMIN_CSRF_");

    // Erros de CSRF não invalidam a sessão legítima. Para qualquer outro erro de
    // autenticação, removemos o cookie local para impedir loops de sessão inválida.
    if (statusCode !== 503 && !isCsrfError) {
      clearAdminSessionCookie(res);
    }

    console.warn("[ADMIN_AUTH_SESSION_INVALID]", {
      path: req.originalUrl,
      method: req.method,
      reason: error?.code || error?.message || "SESSION_ERROR",
    });

    const safeSessionCode =
      statusCode === 401 || statusCode === 419
        ? String(error?.code || "ADMIN_SESSION_INVALID")
        : undefined;

    return res.status(statusCode).json({
      success: false,
      ...(safeSessionCode ? { code: safeSessionCode } : {}),
      message:
        statusCode === 503
          ? "Não foi possível validar a sessão agora. Tente novamente."
          : error?.message || "Sessão inválida ou expirada.",
    });
  }
}

export function requireAdminRole(req, res, next) {
  if (!req.admin) {
    return res.status(401).json({
      success: false,
      message: "Administrador não autenticado.",
    });
  }

  if (!String(req.admin.role || "").trim()) {
    return res.status(403).json({
      success: false,
      message: "Administrador sem função válida.",
    });
  }

  return next();
}

export function requireAdminRoles(...allowedRoles) {
  const normalizedAllowedRoles = allowedRoles
    .flat()
    .map((role) => String(role || "").trim().toLowerCase())
    .filter(Boolean);

  return function requireConfiguredAdminRole(req, res, next) {
    if (!req.admin) {
      return res.status(401).json({
        success: false,
        message: "Administrador não autenticado.",
      });
    }

    const currentRole = String(req.admin.role || "").trim().toLowerCase();

    if (!normalizedAllowedRoles.includes(currentRole)) {
      return res.status(403).json({
        success: false,
        message: "Seu perfil não possui permissão para esta operação.",
      });
    }

    return next();
  };
}
