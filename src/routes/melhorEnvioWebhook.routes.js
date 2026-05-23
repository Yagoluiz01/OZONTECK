import express from "express";
import { handleMelhorEnvioWebhook } from "../services/melhorEnvioWebhook.service.js";

const router = express.Router();

router.get("/health", (req, res) => {
  return res.status(200).json({
    success: true,
    message: "Webhook Melhor Envio ativo",
  });
});

router.post("/webhook", async (req, res) => {
  try {
    const result = await handleMelhorEnvioWebhook({
      payload: req.body || {},
      rawBody: req.rawBody || Buffer.from(JSON.stringify(req.body || {}), "utf8"),
      signature:
        req.get("X-ME-Signature") ||
        req.get("x-me-signature") ||
        req.get("X-ME-WEBHOOK-SIGNATURE") ||
        req.get("x-me-webhook-signature") ||
        "",
    });

    return res.status(200).json(result);
  } catch (error) {
    const statusCode = Number(error?.statusCode || error?.status || 500);

    console.error("[MELHOR_ENVIO_WEBHOOK_ERROR]", {
      statusCode,
      message: error?.message || String(error),
    });

    return res.status(statusCode).json({
      success: false,
      message: error?.message || "Erro ao processar webhook Melhor Envio.",
    });
  }
});

export default router;
