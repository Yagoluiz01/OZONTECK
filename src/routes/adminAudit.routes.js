import express from "express";

import { requireAdminAuth } from "../middlewares/auth.middleware.js";
import {
  isMasterAdmin,
  requireMasterAdmin,
} from "../middlewares/masterAdmin.middleware.js";
import { getAuditDashboard } from "../services/audit.service.js";

const router = express.Router();

router.get("/access", requireAdminAuth, (req, res) => {
  return res.status(200).json({
    success: true,
    is_master: isMasterAdmin(req.admin),
  });
});

router.get("/logs", requireAdminAuth, requireMasterAdmin, async (req, res, next) => {
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

export default router;
