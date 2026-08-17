import express from "express";
import { requireAdminAuth } from "../middlewares/auth.middleware.js";
import { requirePermission } from "../middlewares/permission.middleware.js";
import { getStockIntelligence } from "../services/stock.service.js";

const router = express.Router();

router.use(requireAdminAuth, requirePermission("products.view"));

router.get("/intelligence", async (req, res) => {
  try {
    const intelligence = await getStockIntelligence(req.query || {});
    res.set("Cache-Control", "no-store");
    return res.status(200).json({
      success: true,
      intelligence,
    });
  } catch (error) {
    console.error("[STOCK_INTELLIGENCE_ERROR]", {
      message: error?.message || String(error),
    });

    return res.status(500).json({
      success: false,
      message: error?.message || "Erro ao calcular inteligência de estoque.",
    });
  }
});

export default router;
