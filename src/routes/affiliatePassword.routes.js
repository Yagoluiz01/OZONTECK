import express from "express";
import crypto from "crypto";
import bcrypt from "bcryptjs";

import { supabaseAdmin } from "../config/supabase.js";
import { requestAffiliatePasswordReset } from "../services/affiliatePortal.service.js";

const router = express.Router();

const RESET_TOKEN_PATTERN = /^[a-f0-9]{64}$/i;
const BCRYPT_MAX_PASSWORD_BYTES = 72;

const PASSWORD_RESET_MIN_RESPONSE_MS = 700;

async function enforcePasswordResetRequestDuration(startedAtMs) {
  const jitterMs = crypto.randomInt(0, 121);
  const targetMs = PASSWORD_RESET_MIN_RESPONSE_MS + jitterMs;
  const elapsed = Date.now() - startedAtMs;
  const remaining = Math.max(0, targetMs - elapsed);
  if (remaining > 0) {
    await new Promise((resolve) => setTimeout(resolve, remaining));
  }
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token || ""), "utf8").digest("hex");
}

function passwordByteLength(password) {
  return Buffer.byteLength(String(password || ""), "utf8");
}

function isStrongPassword(password) {
  return (
    typeof password === "string" &&
    password.length >= 12 &&
    passwordByteLength(password) <= BCRYPT_MAX_PASSWORD_BYTES &&
    /[A-Z]/.test(password) &&
    /[a-z]/.test(password) &&
    /[0-9]/.test(password)
  );
}

function passwordPolicyMessage() {
  return "A nova senha precisa ter pelo menos 12 caracteres, com letra maiúscula, letra minúscula e número, sem ultrapassar 72 bytes.";
}

router.post("/forgot-password", async (req, res) => {
  const startedAtMs = Date.now();
  const email = normalizeEmail(req.body?.email);
  const genericMessage =
    "Se este e-mail estiver cadastrado, enviaremos um link para redefinir sua senha.";

  if (!email || !email.includes("@")) {
    return res.status(400).json({
      success: false,
      message: "Informe um e-mail válido.",
    });
  }

  try {
    await requestAffiliatePasswordReset({
      email,
      ipAddress: req.ip || req.socket?.remoteAddress || null,
      userAgent: req.get?.("user-agent") || req.headers?.["user-agent"] || null,
    });
  } catch (error) {
    // Resposta pública permanece igual para impedir enumeração de conta por
    // falhas de SMTP, banco ou geração do token.
    console.error("[AFFILIATE_PUBLIC_PASSWORD_RESET_REQUEST_ERROR]", {
      message: error?.message || String(error),
      code: error?.code || null,
    });
  }

  await enforcePasswordResetRequestDuration(startedAtMs);

  return res.json({
    success: true,
    message: genericMessage,
  });
});

router.post("/reset-password", async (req, res) => {
  try {
    const token = String(req.body?.token || "").trim();
    const newPassword = String(req.body?.password || "");

    if (!RESET_TOKEN_PATTERN.test(token)) {
      return res.status(400).json({
        success: false,
        message: "Link inválido, expirado ou já utilizado.",
      });
    }

    if (!isStrongPassword(newPassword)) {
      return res.status(400).json({
        success: false,
        message: passwordPolicyMessage(),
      });
    }

    const tokenHash = hashToken(token);
    const passwordHash = await bcrypt.hash(newPassword, 12);

    const { data, error: resetError } = await supabaseAdmin.rpc(
      "reset_affiliate_password_atomic",
      {
        p_token_hash: tokenHash,
        p_password_hash: passwordHash,
      }
    );

    if (resetError) {
      console.error("RESET PASSWORD ATOMIC RPC ERROR:", {
        code: resetError.code,
        message: resetError.message,
      });

      return res.status(500).json({
        success: false,
        message: "Erro ao redefinir senha.",
      });
    }

    const result = Array.isArray(data) ? data[0] || null : data;

    if (!result?.affiliate_id) {
      return res.status(400).json({
        success: false,
        message: "Link inválido, expirado ou já utilizado.",
      });
    }

    return res.json({
      success: true,
      message:
        "Senha redefinida com sucesso. As sessões anteriores foram encerradas.",
    });
  } catch (error) {
    console.error("RESET PASSWORD ERROR:", error);

    return res.status(500).json({
      success: false,
      message: "Erro interno ao redefinir senha.",
    });
  }
});

export default router;
