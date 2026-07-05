import express from "express";
import { runAI } from "../core/ai.core.js";
import { formatError, formatResponse } from "../core/response.core.js";

const router = express.Router();

// SECURITY: este endpoint não deve ser usado pelo Front.
// Ele existe para compatibilidade, mas é bloqueado por governança,
// pois hoje não passa pela security/governance do aiChat.
router.post("/ai/run", async (req, res) => {
  return res.status(403).json(
    formatResponse({
      success: false,
      reply: "Endpoint desativado para segurança. Use /api/admin/ai/chat.",
      data: {},
      actions: [],
      metadata: {
        security: "endpoint_blocked",
        route: "/api/ai/ai/run",
      },
    })
  );
});

export default router;
