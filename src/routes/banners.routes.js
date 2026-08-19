import express from "express";
import { requireAdminAuth } from "../middlewares/auth.middleware.js";
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
  trackBannerEvent,
} from "../controllers/banners.controller.js";

const router = express.Router();

const requireAuth = requireAdminAuth;

// Rotas públicas (para a loja)
router.get("/active", listActiveBanners);
router.post("/tracking", trackBannerEvent); // Tracking detalhado: impressão, clique e tempo
router.post("/:id/click", trackBannerClick); // Rastreamento simples de cliques (compatibilidade)
router.post("/:id/view", trackBannerView); // Rastreamento simples de visualizações (compatibilidade)

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
