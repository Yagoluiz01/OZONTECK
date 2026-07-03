import express from "express";
import { runAI } from "../services/AI/core/ai.core.js";
import { runAgent } from "../services/AI/agent/index.js";

const router = express.Router();


router.post("/ai/run", async (req, res) => {
  try {
    const { message, contexts } = req.body;

    const result = await runAI({
      message,
      contexts,
    });

    return res.json(result);
  } catch (error) {
    return res.status(500).json({
      error: error.message,
    });
  }
});

router.post("/agent/run", async (req, res) => {
  try {
    const { message, contexts = [] } = req.body;

    // permissões e user (se existir middleware de auth no futuro)
    // nesta fase: default empty.
      const result = await runAgent({
        message,
        contexts,
        user: req.admin || req.body?.user || { id: null, role: "unknown" },
        permissions: req.permissions || req.body?.permissions || [],
        history: req.body?.history || [],
        requestId: req.headers?.["x-request-id"] || req.body?.requestId || null,
      });

      return res.json(result);

  } catch (error) {
    console.error('[AGENT_RUN_ERROR]', error);
    return res.status(500).json({
      success: false,
      error: error?.message,
      stack: error?.stack,
    });
  }
});

export default router;

