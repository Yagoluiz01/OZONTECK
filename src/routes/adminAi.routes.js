import express from "express";
import { requireAdminAuth } from "../middlewares/auth.middleware.js";
import { aiChat } from "../controllers/adminAi.controller.js";

const router = express.Router();

router.post("/chat", requireAdminAuth, aiChat);

export default router;
