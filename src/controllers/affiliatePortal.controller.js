import crypto from "crypto";

import {
  checkAffiliateAccessByEmail,
  getAffiliateOrders,
  getAffiliatePayouts,
  getAffiliateSummary,
  getAffiliateNetwork,
  getAffiliatePromotionalProducts,
  getAffiliateStorefront,
  addAffiliateStorefrontItem,
  removeAffiliateStorefrontItem,
  updateAffiliateStorefrontProfilePhoto,
  loginAffiliate,
  requestAffiliatePasswordReset,
  updateAffiliateProfile,
} from "../services/affiliatePortal.service.js";
import { syncAffiliateLevelAchievement } from "../services/affiliateCommunityAchievements.service.js";
import { buildPublicApiError } from "../utils/publicApiError.js";
import {
  clearAffiliateSessionCookie,
  createAffiliateSession,
  revokeAffiliateSessionToken,
  setAffiliateSessionCookie,
} from "../services/affiliateSession.service.js";
import {
  checkAffiliateLoginGuard,
  enforceMinimumAffiliateLoginDuration,
  registerAffiliateLoginFailure,
  registerAffiliateLoginSuccess,
  setAffiliateLoginRetryAfter,
} from "../services/affiliateLoginGuard.service.js";
import { recordAffiliateLoginAttempt } from "../services/affiliateIntrusionDetection.service.js";
import { signAffiliateLegacyBridgeToken } from "../services/affiliateLegacyBridge.service.js";

const AFFILIATE_PASSWORD_RESET_MIN_RESPONSE_MS = 700;

async function enforceAffiliatePasswordResetResponseDuration(startedAtMs) {
  const jitterMs = crypto.randomInt(0, 121);
  const targetMs = AFFILIATE_PASSWORD_RESET_MIN_RESPONSE_MS + jitterMs;
  const elapsed = Date.now() - startedAtMs;
  const remaining = Math.max(0, targetMs - elapsed);
  if (remaining > 0) {
    await new Promise((resolve) => setTimeout(resolve, remaining));
  }
}

function sendError(res, error) {
  const publicError = buildPublicApiError(error, {
    fallbackMessage: "Erro interno no painel do afiliado.",
  });

  console.error("AFFILIATE PORTAL ERROR:", error);

  return res.status(publicError.status).json(publicError.body);
}

export async function login(req, res) {
  const startedAtMs = Date.now();
  const email = String(req.body?.email || "").trim().toLowerCase();

  try {
    const guard = await checkAffiliateLoginGuard({ email, req });

    if (guard.blocked) {
      recordAffiliateLoginAttempt({
        req,
        email,
        success: false,
        reason: "rate_limited",
      });
      await enforceMinimumAffiliateLoginDuration(startedAtMs);
      setAffiliateLoginRetryAfter(res, guard.retryAfterSeconds);
      return res.status(429).json({
        success: false,
        message: "Muitas tentativas de acesso. Aguarde alguns minutos e tente novamente.",
      });
    }

    const result = await loginAffiliate(req.body || {});

    // Fail closed: nenhuma sessão nasce se o guard persistente não puder ser limpo.
    await registerAffiliateLoginSuccess({ email });

    const secureSession = await createAffiliateSession({
      req,
      affiliate: result.affiliate,
    });

    setAffiliateSessionCookie(res, secureSession.token);

    recordAffiliateLoginAttempt({
      req,
      email,
      success: true,
      reason: "success",
    });

    const legacyBridgeToken = signAffiliateLegacyBridgeToken({
      ...result.affiliate,
      authVersion: result.authVersion,
    });

    return res.json({
      success: true,
      message: "Login realizado com sucesso.",
      ...(legacyBridgeToken ? { token: legacyBridgeToken } : {}),
      affiliate: result.affiliate,
      secure_session: {
        csrf_token: secureSession.csrfToken,
        expires_at: secureSession.session.expires_at,
        idle_expires_at: secureSession.session.idle_expires_at,
        replaced_sessions: secureSession.revokedSessions,
      },
    });
  } catch (error) {
    if (Number(error?.statusCode) === 401) {
      try {
        const failure = await registerAffiliateLoginFailure({ email, req });
        recordAffiliateLoginAttempt({
          req,
          email,
          success: false,
          reason: "invalid_credentials",
        });

        await enforceMinimumAffiliateLoginDuration(startedAtMs);

        if (failure.blocked) {
          setAffiliateLoginRetryAfter(res, failure.retryAfterSeconds);
          return res.status(429).json({
            success: false,
            message: "Muitas tentativas de acesso. Aguarde alguns minutos e tente novamente.",
          });
        }

        return res.status(401).json({
          success: false,
          message: "E-mail ou senha inválidos.",
        });
      } catch (guardError) {
        await enforceMinimumAffiliateLoginDuration(startedAtMs);
        return sendError(res, guardError);
      }
    }

    if (Number(error?.statusCode) >= 500) {
      await enforceMinimumAffiliateLoginDuration(startedAtMs);
    }

    return sendError(res, error);
  }
}

export async function logout(req, res) {
  try {
    const token = req.affiliateSessionToken;
    if (token) {
      await revokeAffiliateSessionToken(token, "logout");
    }

    clearAffiliateSessionCookie(res);

    return res.json({
      success: true,
      message: "Sessão encerrada com sucesso.",
    });
  } catch (error) {
    clearAffiliateSessionCookie(res);
    return sendError(res, error);
  }
}

export async function forgotPassword(req, res) {
  const startedAtMs = Date.now();
  const email = String(req.body?.email || "").trim().toLowerCase();
  const genericMessage =
    "Se este e-mail estiver cadastrado e apto, enviaremos um link para redefinir sua senha.";

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
    // Não transforma falha de SMTP/DB em oráculo de existência da conta.
    console.error("[AFFILIATE_PASSWORD_RESET_REQUEST_ERROR]", {
      message: error?.message || String(error),
      code: error?.code || null,
    });
  }

  await enforceAffiliatePasswordResetResponseDuration(startedAtMs);

  return res.json({
    success: true,
    message: genericMessage,
  });
}

export async function checkEmail(req, res) {
  try {
    const result = await checkAffiliateAccessByEmail(req.body || {});

    return res.json({
      success: true,
      ...result,
    });
  } catch (error) {
    return sendError(res, error);
  }
}

export async function me(req, res) {
  try {
    return res.json({
      success: true,
      affiliate: req.affiliate,
      secure_session: {
        csrf_token: req.affiliateCsrfToken || null,
        expires_at: req.affiliateSession?.expires_at || null,
        idle_expires_at: req.affiliateSession?.idle_expires_at || null,
      },
    });
  } catch (error) {
    return sendError(res, error);
  }
}

export async function summary(req, res) {
  try {
    res.set({
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      Pragma: "no-cache",
      Expires: "0",
    });

    const result = await getAffiliateSummary(req.affiliateId);

    let achievement = null;
    try {
      const syncResult = await syncAffiliateLevelAchievement(req.affiliateId);
      achievement = syncResult?.achievement || null;
    } catch (syncError) {
      console.error("AFFILIATE_ACHIEVEMENT_SYNC_WARN:", {
        affiliateId: req.affiliateId,
        message: syncError?.message,
        details: syncError?.details,
      });
    }

    return res.json({
      success: true,
      affiliate: result.affiliate,
      summary: result.summary,
      level_goal: result.level_goal,
      level_bonuses: result.level_bonuses,
      levels: result.levels || [],
      achievement,
      refreshed_at: new Date().toISOString(),
    });
  } catch (error) {
    return sendError(res, error);
  }
}

export async function orders(req, res) {
  try {
    const result = await getAffiliateOrders(req.affiliateId);

    return res.json({
      success: true,
      orders: result,
    });
  } catch (error) {
    return sendError(res, error);
  }
}

export async function payouts(req, res) {
  try {
    const result = await getAffiliatePayouts(req.affiliateId);

    return res.json({
      success: true,
      payouts: result,
    });
  } catch (error) {
    return sendError(res, error);
  }
}


export async function products(req, res) {
  try {
    const result = await getAffiliatePromotionalProducts(req.affiliateId);

    return res.json({
      success: true,
      affiliate: result.affiliate,
      products: result.products,
    });
  } catch (error) {
    return sendError(res, error);
  }
}

export async function storefront(req, res) {
  try {
    const result = await getAffiliateStorefront(req.affiliateId);

    res.set({
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      Pragma: "no-cache",
      Expires: "0",
    });

    return res.json({
      success: true,
      ...result,
    });
  } catch (error) {
    return sendError(res, error);
  }
}

export async function addStorefrontItem(req, res) {
  try {
    const result = await addAffiliateStorefrontItem(req.affiliateId, req.body || {});

    return res.status(201).json({
      success: true,
      message: "Produto adicionado à sua loja.",
      ...result,
    });
  } catch (error) {
    return sendError(res, error);
  }
}

export async function removeStorefrontItem(req, res) {
  try {
    const result = await removeAffiliateStorefrontItem(
      req.affiliateId,
      req.params.productId
    );

    return res.json({
      success: true,
      message: "Produto removido da sua loja.",
      ...result,
    });
  } catch (error) {
    return sendError(res, error);
  }
}


export async function updateStorefrontProfilePhoto(req, res) {
  try {
    const result = await updateAffiliateStorefrontProfilePhoto(
      req.affiliateId,
      req.body || {}
    );

    return res.json({
      success: true,
      message: result?.storefront?.profile_photo_url
        ? "Foto de perfil da loja atualizada."
        : "Foto de perfil da loja removida.",
      ...result,
    });
  } catch (error) {
    return sendError(res, error);
  }
}

export async function network(req, res) {
  try {
    const result = await getAffiliateNetwork(req.affiliateId);

    return res.json({
      success: true,
      ...result,
    });
  } catch (error) {
    return sendError(res, error);
  }
}

export async function updateProfile(req, res) {
  try {
    const affiliate = await updateAffiliateProfile(req.affiliateId, req.body || {});

    return res.json({
      success: true,
      message: "Perfil atualizado com sucesso.",
      affiliate,
    });
  } catch (error) {
    return sendError(res, error);
  }
}
