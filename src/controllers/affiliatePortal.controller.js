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

function sendError(res, error) {
  const statusCode = error.statusCode || 500;

  console.error("AFFILIATE PORTAL ERROR:", error);

  return res.status(statusCode).json({
    success: false,
    message: error.message || "Erro interno no painel do afiliado.",
  });
}

export async function login(req, res) {
  try {
    const result = await loginAffiliate(req.body || {});

    return res.json({
      success: true,
      message: "Login realizado com sucesso.",
      token: result.token,
      affiliate: result.affiliate,
    });
  } catch (error) {
    return sendError(res, error);
  }
}

export async function forgotPassword(req, res) {
  try {
    await requestAffiliatePasswordReset(req.body || {});

    return res.json({
      success: true,
      message:
        "Se o Gmail estiver cadastrado e ativo, enviaremos uma nova senha temporária.",
    });
  } catch (error) {
    return sendError(res, error);
  }
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