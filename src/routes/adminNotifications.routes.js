import express from "express";
import { requireAdminAuth } from "../middlewares/auth.middleware.js";
import { requirePermission } from "../middlewares/permission.middleware.js";
import {
  createAdminNotification,
  deleteAllAdminNotifications,
  listAdminNotifications,
  markAdminNotificationAsRead,
  markAllAdminNotificationsAsRead,
} from "../services/adminNotifications.service.js";

const router = express.Router();

router.use(requireAdminAuth, requirePermission("notifications.view"));

router.get("/", async (req, res, next) => {
  try {
    const limit = req.query.limit || 20;
    const onlyUnread =
      String(req.query.onlyUnread || "").toLowerCase() === "true";

    const result = await listAdminNotifications({
      limit,
      onlyUnread,
      recipientAdminId: req.admin?.id,
    });

    return res.json({
      success: true,
      ...result,
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/", requirePermission("notifications.edit"), async (req, res, next) => {
  try {
    const result = await createAdminNotification(req.body || {});

    return res.status(201).json(result);
  } catch (error) {
    return next(error);
  }
});


router.delete("/all", requirePermission("notifications.edit"), async (req, res, next) => {
  try {
    const result = await deleteAllAdminNotifications();

    return res.json({
      success: true,
      message: "Todas as notificações foram removidas.",
      ...result,
    });
  } catch (error) {
    return next(error);
  }
});

router.patch("/:id/read", async (req, res, next) => {
  try {
    const notification = await markAdminNotificationAsRead(req.params.id);

    return res.json({
      success: true,
      notification,
      message: "Notificação marcada como lida.",
    });
  } catch (error) {
    return next(error);
  }
});

router.patch("/read-all", async (req, res, next) => {
  try {
    await markAllAdminNotificationsAsRead();

    return res.json({
      success: true,
      message: "Todas as notificações foram marcadas como lidas.",
    });
  } catch (error) {
    return next(error);
  }
});

export default router;
