import jwt from "jsonwebtoken";

import { env } from "../config/env.js";
import { supabaseAdmin } from "../config/supabase.js";

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function getBearerToken(req) {
  const authHeader = String(req.headers.authorization || "");

  if (!authHeader.startsWith("Bearer ")) {
    return null;
  }

  return authHeader.slice("Bearer ".length).trim() || null;
}

async function loadActiveAdmin(decoded) {
  const { data, error } = await supabaseAdmin
    .from("admins")
    .select(`
id,
full_name,
email,
role,
is_active,
auth_user_id,
company_id
`)
    .eq("id", decoded.admin_id)
    .maybeSingle();

  if (error) {
    console.error("[ADMIN_AUTH_DATABASE_ERROR]", {
      admin_id: decoded.admin_id,
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

  if (normalizeEmail(data.email) !== normalizeEmail(decoded.email)) {
    const identityError = new Error("Sessão administrativa inválida.");
    identityError.statusCode = 401;
    throw identityError;
  }

  if (data.auth_user_id && decoded.sub && String(data.auth_user_id) !== String(decoded.sub)) {
    const identityError = new Error("Sessão administrativa inválida.");
    identityError.statusCode = 401;
    throw identityError;
  }

  return data;
}

export async function requireAdminAuth(req, res, next) {
  try {
    const token = getBearerToken(req);

    if (!token) {
      return res.status(401).json({
        success: false,
        message: "Token não enviado.",
      });
    }

    const decoded = jwt.verify(token, env.jwtSecret);

    if (!decoded?.admin_id || !decoded?.email || !decoded?.role) {
      return res.status(401).json({
        success: false,
        message: "Token inválido.",
      });
    }

    // Não confia apenas no JWT: reconsulta o administrador em toda rota protegida.
    // Assim, bloqueio, exclusão ou troca de função passa a valer imediatamente.
    const currentAdmin = await loadActiveAdmin(decoded);

    // Tenant/company enrichment (needed by AI tenant guard)
    // We do not assume a specific column name in `admins`.
    // If present, we propagate it to `req.admin.company_id` / `req.admin.tenant_id`.
    const tenantId = currentAdmin.company_id ?? currentAdmin.tenant_id ?? currentAdmin.tenantId ?? currentAdmin.companyId ?? null;

    req.admin = {
      id: currentAdmin.id,
      userId: currentAdmin.auth_user_id || decoded.sub || null,
      email: currentAdmin.email,
      fullName: currentAdmin.full_name || null,
      role: currentAdmin.role,
      company_id: tenantId,
      tenant_id: tenantId,
    };


    return next();
  } catch (error) {
    const statusCode = Number(error?.statusCode || 401);

    return res.status(statusCode).json({
      success: false,
      message:
        statusCode === 503
          ? "Não foi possível validar a sessão agora. Tente novamente."
          : error?.message || "Token inválido ou expirado.",
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
