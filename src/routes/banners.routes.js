import express from "express";
import { requireAdminAuth as requireAuth } from "../middlewares/auth.middleware.js";
import { env } from "../config/env.js";
import {
  listAllBanners,
  listActiveBanners,
  getBanner,
  getBannerStats,
  createBanner,
  updateBanner,
  deleteBanner,
  duplicateBanner,
  reorderBanners,
  trackBannerClick,
  trackBannerView,
} from "../controllers/banners.controller.js";

const router = express.Router();

// Rotas públicas (para a loja)
router.get("/active", listActiveBanners);
router.post("/:id/click", trackBannerClick); // Rastreamento de cliques (pública)
router.post("/:id/view", trackBannerView); // Rastreamento de visualizações (pública)

// Rotas administrativas (protegidas)
router.get("/", requireAuth, listAllBanners);
router.post("/", requireAuth, createBanner);
router.patch("/reorder", requireAuth, reorderBanners);
router.get("/:id/stats", requireAuth, getBannerStats);
router.get("/:id", requireAuth, getBanner);
router.put("/:id", requireAuth, updateBanner);
router.delete("/:id", requireAuth, deleteBanner);
router.post("/:id/duplicate", requireAuth, duplicateBanner);

export { requireAuth };
export default router;
