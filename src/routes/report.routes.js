import { Router } from "express";
import { generateProductsReport } from "../controllers/report.controller.js";

const router = Router();

router.get(
  "/products/excel",
  generateProductsReport
);

export default router;