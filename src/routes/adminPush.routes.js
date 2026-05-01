import express from "express";
import { requireAdminAuth } from "../middlewares/auth.middleware.js";
import {
  getVapidPublicKey,
  saveAdminPushSubscription,
  sendPushToAdmins,
} from "../services/adminPush.service.js";

const router = express.Router();

router.use(requireAdminAuth);

router.get("/public-key", (req, res) => {
  const publicKey = getVapidPublicKey();

  if (!publicKey) {
    return res.status(500).json({
      success: false,
      message: "VAPID_PUBLIC_KEY não configurada.",
    });
  }

  return res.json({
    success: true,
    publicKey,
  });
});

router.post("/subscribe", async (req, res, next) => {
  try {
    const subscription = req.body?.subscription || req.body;
    const userAgent = req.headers["user-agent"] || "";

    const saved = await saveAdminPushSubscription({
      admin: req.admin,
      subscription,
      userAgent,
    });

    return res.status(201).json({
      success: true,
      subscription: saved,
      message: "Celular autorizado para receber notificações.",
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/test", async (req, res, next) => {
  try {
    const result = await sendPushToAdmins({
      type: "system_test",
      title: "Teste OZONTECK",
      message: "Notificação push funcionando no celular.",
      entity_type: "system",
    });

    return res.json({
      success: true,
      result,
    });
  } catch (error) {
    return next(error);
  }
});

export default router;