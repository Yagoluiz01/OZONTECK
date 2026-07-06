import express from "express";

import { requireAdminAuth } from "../middlewares/auth.middleware.js";
import { requirePermission } from "../middlewares/permission.middleware.js";
import {
  assignAdminPermissions,
  getPermissionCatalogGrouped,
  setAdminMasterFlag,
} from "../services/permissions/permission.service.js";
import { getAdminPermissions } from "../repositories/permission.repository.js";

const router = express.Router();

function normalizePermissionArray(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean))];
}

router.get(
  "/admin/permissions/catalog",
  requireAdminAuth,
  requirePermission("admins.permissions"),
  async (_req, res, next) => {
    try {
      const result = await getPermissionCatalogGrouped();

      return res.json({
        success: true,
        catalog: result.catalog,
        grouped: result.grouped,
      });
    } catch (error) {
      return next(error);
    }
  }
);

router.get(
  "/admin/admins/:id/permissions",
  requireAdminAuth,
  requirePermission("admins.permissions"),
  async (req, res, next) => {
    try {
      const adminId = String(req.params.id || "").trim();
      const permissions = await getAdminPermissions(adminId);

      return res.json({
        success: true,
        admin_id: adminId,
        permissions,
      });
    } catch (error) {
      return next(error);
    }
  }
);

router.put(
  "/admin/admins/:id/permissions",
  requireAdminAuth,
  requirePermission("admins.permissions"),
  async (req, res, next) => {
    try {
      const adminId = String(req.params.id || "").trim();
      const permissions = normalizePermissionArray(req.body?.permissions);
      const isMaster = Boolean(req.body?.is_master);

      const result = await assignAdminPermissions({
        adminId,
        permissions,
        isMaster,
      });

      return res.json({
        success: true,
        message: "Permissões do administrador atualizadas com sucesso.",
        admin: result.admin,
        permissions: result.permissions,
        is_master: result.is_master,
      });
    } catch (error) {
      return next(error);
    }
  }
);

router.patch(
  "/admin/admins/:id/master",
  requireAdminAuth,
  requirePermission("admins.permissions"),
  async (req, res, next) => {
    try {
      const adminId = String(req.params.id || "").trim();
      const isMaster = Boolean(req.body?.is_master);

      const admin = await setAdminMasterFlag({
        adminId,
        isMaster,
      });

      return res.json({
        success: true,
        message: isMaster
          ? "Acesso master concedido com sucesso."
          : "Acesso master removido com sucesso.",
        admin,
      });
    } catch (error) {
      return next(error);
    }
  }
);

export default router;
