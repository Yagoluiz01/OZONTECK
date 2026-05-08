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
  products,
  updateProfile,
} from "../controllers/affiliatePortal.controller.js";

import { requireAffiliateAuth } from "../middlewares/affiliateAuth.middleware.js";
import {
  getPushConfig,
  subscribeAffiliatePush,
  unsubscribeAffiliatePush,
  sendAffiliateTestPush,
} from "../controllers/affiliatePush.controller.js";

const router = express.Router();

router.post("/auth/login", login);
router.post("/auth/forgot-password", forgotPassword);
router.post("/auth/check-email", checkEmail);

router.get("/me", requireAffiliateAuth, me);
router.get("/summary", requireAffiliateAuth, summary);
router.get("/orders", requireAffiliateAuth, orders);
router.get("/payouts", requireAffiliateAuth, payouts);
router.get("/network", requireAffiliateAuth, network);
router.get("/products", requireAffiliateAuth, products);
router.put("/profile", requireAffiliateAuth, updateProfile);

router.get("/push/config", requireAffiliateAuth, getPushConfig);
router.post("/push/subscribe", requireAffiliateAuth, subscribeAffiliatePush);
router.delete("/push/unsubscribe", requireAffiliateAuth, unsubscribeAffiliatePush);
router.post("/push/test", requireAffiliateAuth, sendAffiliateTestPush);

export default router;