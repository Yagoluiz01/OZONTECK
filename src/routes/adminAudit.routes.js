import express from "express";

import { requireAdminAuth } from "../middlewares/auth.middleware.js";
import { isMasterAdmin } from "../middlewares/masterAdmin.middleware.js";
import { requirePermission } from "../middlewares/permission.middleware.js";
import {
  deleteAuditLog,
  getAuditDashboard,
} from "../services/audit.service.js";

const router = express.Router();

router.get("/access", requireAdminAuth, (req, res) => {
  return res.status(200).json({
    success: true,
    is_master: isMasterAdmin(req.admin),
  });
});

router.get("/logs", requireAdminAuth, requirePermission("audit.read"), async (req, res, next) => {
  try {
    const data = await getAuditDashboard({
      page: req.query.page,
      limit: req.query.limit,
      module: req.query.module,
      action: req.query.action,
      status: req.query.status,
      adminId: req.query.admin_id,
      search: req.query.search,
      dateFrom: req.query.date_from,
      dateTo: req.query.date_to,
    });

    return res.status(200).json({
      success: true,
      ...data,
    });
  } catch (error) {
    return next(error);
  }
});

router.delete("/logs/:id", requireAdminAuth, requirePermission("audit.delete"), async (req, res, next) => {
  try {
    const deleted = await deleteAuditLog({ id: req.params.id });

    return res.status(200).json({
      success: true,
      message: "Registro excluído com sucesso.",
      deleted,
    });
  } catch (error) {
    return next(error);
  }
});

export default router;
