import express from "express";

import {
  login,
  me,
  orders,
  payouts,
  summary,
  updateProfile,
} from "../controllers/affiliatePortal.controller.js";

import { requireAffiliateAuth } from "../middlewares/affiliateAuth.middleware.js";

const router = express.Router();

router.post("/auth/login", login);

router.get("/me", requireAffiliateAuth, me);
router.get("/summary", requireAffiliateAuth, summary);
router.get("/orders", requireAffiliateAuth, orders);
router.get("/payouts", requireAffiliateAuth, payouts);
router.put("/profile", requireAffiliateAuth, updateProfile);

export default router;