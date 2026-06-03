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
  storefront,
  addStorefrontItem,
  removeStorefrontItem,
  updateStorefrontProfilePhoto,
  updateProfile,
} from "../controllers/affiliatePortal.controller.js";

import { requireAffiliateAuth } from "../middlewares/affiliateAuth.middleware.js";
import {
  getPushConfig,
  subscribeAffiliatePush,
  unsubscribeAffiliatePush,
  sendAffiliateTestPush,
} from "../controllers/affiliatePush.controller.js";
import {
  congratulate,
  listAchievements,
} from "../controllers/affiliateCommunityAchievements.controller.js";

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
router.get("/storefront", requireAffiliateAuth, storefront);
router.post("/storefront/items", requireAffiliateAuth, addStorefrontItem);
router.patch("/storefront/profile-photo", requireAffiliateAuth, updateStorefrontProfilePhoto);
router.delete("/storefront/items/:productId", requireAffiliateAuth, removeStorefrontItem);
router.put("/profile", requireAffiliateAuth, updateProfile);

router.get("/community/achievements", requireAffiliateAuth, listAchievements);
router.post("/community/achievements/:achievementId/congratulate", requireAffiliateAuth, congratulate);

router.get("/push/config", requireAffiliateAuth, getPushConfig);
router.post("/push/subscribe", requireAffiliateAuth, subscribeAffiliatePush);
router.delete("/push/unsubscribe", requireAffiliateAuth, unsubscribeAffiliatePush);
router.post("/push/test", requireAffiliateAuth, sendAffiliateTestPush);

export default router;