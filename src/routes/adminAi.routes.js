import express from "express";
import { requireAdminAuth } from "../middlewares/auth.middleware.js";
import {
  enrichAdminPermissions,
  requireAnyPermission,
  requirePermission,
} from "../middlewares/permission.middleware.js";
import {
  aiChat,
  improveProductDescription,
} from "../controllers/adminAi.controller.js";

const router = express.Router();

router.post(
  "/chat",
  requireAdminAuth,
  enrichAdminPermissions,
  requirePermission("ai.use"),
  aiChat
);

router.post(
  "/products/improve-description",
  requireAdminAuth,
  enrichAdminPermissions,
  requirePermission("ai.use"),
  requireAnyPermission(["products.create", "products.edit"]),
  improveProductDescription
);

export default router;
