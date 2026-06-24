import { Router } from "express";
import { generateProductsReport } from "../controllers/report.controller.js";
import { requireAdminAuth } from "../middlewares/auth.middleware.js";
import { requireMasterAdmin } from "../middlewares/masterAdmin.middleware.js";

const router = Router();

router.use(requireAdminAuth);
router.use(requireMasterAdmin);

router.get(
  "/products/excel",
  generateProductsReport
);

export default router;