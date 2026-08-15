import express from "express";
import { runAI } from "../services/AI/core/ai.core.js";
import { runAgent } from "../services/AI/agent/index.js";
import { filterContextsByPermission } from "../services/AI/permissions/permissions.engine.js";
import { requireAdminAuth } from "../middlewares/auth.middleware.js";
import {
  enrichAdminPermissions,
  requirePermission,
} from "../middlewares/permission.middleware.js";
import { buildPublicApiError } from "../utils/publicApiError.js";

const router = express.Router();
const MAX_MESSAGE_LENGTH = 4000;
const MAX_HISTORY_ITEMS = 20;

router.use(requireAdminAuth);
router.use(enrichAdminPermissions);
router.use(requirePermission("ai.use"));

function normalizeMessage(value) {
  return String(value || "").replace(/\0/g, "").trim();
}

function normalizeContexts(contexts, permissions) {
  const requested = Array.isArray(contexts)
    ? contexts
        .filter((context) => typeof context === "string")
        .map((context) => context.trim())
        .filter(Boolean)
    : [];

  if (permissions.includes("*")) {
    return requested;
  }

  return filterContextsByPermission(requested, permissions);
}

function normalizeHistory(history) {
  if (!Array.isArray(history)) return [];

  return history
    .slice(-MAX_HISTORY_ITEMS)
    .filter((item) => {
      const role = String(item?.role || "");
      const content = normalizeMessage(item?.content);
      return (role === "user" || role === "assistant") && content.length > 0;
    })
    .map((item) => ({
      role: String(item.role),
      content: normalizeMessage(item.content).slice(0, MAX_MESSAGE_LENGTH),
    }));
}

function validateMessage(req, res) {
  const message = normalizeMessage(req.body?.message);

  if (!message) {
    res.status(400).json({
      success: false,
      message: "Mensagem não pode estar vazia.",
    });
    return null;
  }

  if (message.length > MAX_MESSAGE_LENGTH) {
    res.status(400).json({
      success: false,
      message: "Mensagem muito longa.",
    });
    return null;
  }

  return message;
}

function sendInternalError(res, error, logLabel) {
  console.error(logLabel, error);
  const publicError = buildPublicApiError(error, {
    fallbackMessage: "Erro interno ao processar a solicitação de IA.",
  });

  return res.status(publicError.status).json(publicError.body);
}

router.post("/ai/run", async (req, res) => {
  try {
    const message = validateMessage(req, res);
    if (!message) return;

    const permissions = Array.isArray(req.admin?.permissions)
      ? req.admin.permissions
      : [];
    const contexts = normalizeContexts(req.body?.contexts, permissions);

    const result = await runAI({
      message,
      contexts,
    });

    return res.json(result);
  } catch (error) {
    return sendInternalError(res, error, "[LEGACY_AI_RUN_ERROR]");
  }
});

router.post("/agent/run", async (req, res) => {
  try {
    const message = validateMessage(req, res);
    if (!message) return;

    const permissions = Array.isArray(req.admin?.permissions)
      ? req.admin.permissions
      : [];
    const contexts = normalizeContexts(req.body?.contexts, permissions);

    const result = await runAgent({
      message,
      contexts,
      user: req.admin,
      permissions,
      history: normalizeHistory(req.body?.history),
      requestId: req.headers?.["x-request-id"] || null,
    });

    return res.json(result);
  } catch (error) {
    return sendInternalError(res, error, "[LEGACY_AGENT_RUN_ERROR]");
  }
});

export default router;
