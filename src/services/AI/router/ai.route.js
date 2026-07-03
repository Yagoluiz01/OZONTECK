import express from "express";
import { runAI } from "../core/ai.core.js";

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

export default router;