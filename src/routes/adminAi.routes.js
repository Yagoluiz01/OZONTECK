import express from "express";
import { requireAdminAuth } from "../middlewares/auth.middleware.js";
import {
  enrichAdminPermissions,
  requirePermission,
} from "../middlewares/permission.middleware.js";
import { aiChat } from "../controllers/adminAi.controller.js";

const router = express.Router();

router.post(
  "/chat",
  requireAdminAuth,
  enrichAdminPermissions,
  requirePermission("ai.use"),
  aiChat
);

export default router;
