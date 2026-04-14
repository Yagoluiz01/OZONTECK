import express from "express";
import {
  buildMelhorEnvioAuthorizeUrl,
  exchangeMelhorEnvioCodeForToken,
  saveMelhorEnvioTokens,
  getMelhorEnvioTokenRecord,
} from "../services/melhorEnvio.service.js";

const router = express.Router();

router.get("/melhor-envio/connect", async (req, res) => {
  try {
    const url = buildMelhorEnvioAuthorizeUrl();

    return res.status(200).json({
      success: true,
      authorizeUrl: url,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || "Erro ao gerar URL de autorização do Melhor Envio",
    });
  }
});

router.get("/melhor-envio/oauth/callback", async (req, res) => {
  try {
    const code = String(req.query.code || "").trim();

    if (!code) {
      return res.status(400).json({
        success: false,
        message: "Code não enviado pelo Melhor Envio",
      });
    }

    const tokenData = await exchangeMelhorEnvioCodeForToken(code);
    await saveMelhorEnvioTokens(tokenData);

    return res.status(200).json({
      success: true,
      message: "Melhor Envio conectado com sucesso",
    });
  } catch (error) {
    console.error("ERRO OAUTH MELHOR ENVIO:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Erro ao concluir OAuth do Melhor Envio",
    });
  }
});

router.get("/melhor-envio/status", async (req, res) => {
  try {
    const record = await getMelhorEnvioTokenRecord();

    return res.status(200).json({
      success: true,
      connected: Boolean(record?.access_token),
      expiresAt: record?.expires_at || null,
      provider: record?.provider || "melhor_envio",
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || "Erro ao consultar status do Melhor Envio",
    });
  }
});

export default router;