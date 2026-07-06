import { getEffectiveAdminPermissions, hasPermission, isMasterAdmin } from "../services/permissions/permission.service.js";

export async function enrichAdminPermissions(req, _res, next) {
  try {
    if (!req.admin?.id) return next();

    const permissions = await getEffectiveAdminPermissions(req.admin);

    req.admin.is_master = isMasterAdmin(req.admin);
    req.admin.permissions = Array.from(permissions);

    return next();
  } catch (error) {
    return next(error);
  }
}

export function requirePermission(permissionKey) {
  const required = String(permissionKey || "").trim();

  return async function permissionGuard(req, res, next) {
    try {
      if (!req.admin?.id) {
        return res.status(401).json({
          success: false,
          message: "Administrador não autenticado.",
        });
      }

      if (!required) {
        return next();
      }

      if (isMasterAdmin(req.admin)) {
        return next();
      }

      const allowed = await hasPermission(req.admin, required);

      if (!allowed) {
        return res.status(403).json({
          success: false,
          message: "Seu perfil não possui permissão para esta operação.",
          required_permission: required,
        });
      }

      return next();
    } catch (error) {
      return next(error);
    }
  };
}
