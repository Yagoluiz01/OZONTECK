import {
  checkAffiliateAccessByEmail,
  getAffiliateOrders,
  getAffiliatePayouts,
  getAffiliateSummary,
  getAffiliateNetwork,
  loginAffiliate,
  requestAffiliatePasswordReset,
  updateAffiliateProfile,
} from "../services/affiliatePortal.service.js";

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
    const result = await getAffiliateSummary(req.affiliateId);

    return res.json({
      success: true,
      affiliate: result.affiliate,
      summary: result.summary,
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