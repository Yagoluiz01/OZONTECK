import express from "express";

import {
  checkEmail,
  forgotPassword,
  login,
  me,
  orders,
  payouts,
  summary,
  network,
  updateProfile,
} from "../controllers/affiliatePortal.controller.js";

import { requireAffiliateAuth } from "../middlewares/affiliateAuth.middleware.js";

const router = express.Router();

router.post("/auth/login", login);
router.post("/auth/forgot-password", forgotPassword);
router.post("/auth/check-email", checkEmail);

router.get("/me", requireAffiliateAuth, me);
router.get("/summary", requireAffiliateAuth, summary);
router.get("/orders", requireAffiliateAuth, orders);
router.get("/payouts", requireAffiliateAuth, payouts);
router.get("/network", requireAffiliateAuth, network);
router.put("/profile", requireAffiliateAuth, updateProfile);

export default router;