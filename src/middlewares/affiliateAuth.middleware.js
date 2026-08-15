import {
  getAffiliateSessionById,
  verifyAffiliateToken,
} from "../services/affiliatePortal.service.js";

function getBearerToken(req) {
  const authorization = req.headers.authorization || "";

  if (!authorization.startsWith("Bearer ")) {
    return null;
  }

  return authorization.replace("Bearer ", "").trim();
}

export async function requireAffiliateAuth(req, res, next) {
  try {
    const token = getBearerToken(req);

    if (!token) {
      return res.status(401).json({
        success: false,
        message: "Token do afiliado não enviado.",
      });
    }

    const decoded = verifyAffiliateToken(token);
    const session = await getAffiliateSessionById(decoded.affiliate_id);
    const tokenAuthVersion = Number(decoded.auth_version);

    if (
      !Number.isInteger(tokenAuthVersion) ||
      tokenAuthVersion !== session.authVersion
    ) {
      const error = new Error("Sessão do afiliado revogada.");
      error.statusCode = 401;
      throw error;
    }

    req.affiliate = session.affiliate;
    req.affiliateId = session.affiliate.id;

    return next();
  } catch (error) {
    console.warn("[AFFILIATE_AUTH_ERROR]", {
      message: error?.message,
      name: error?.name,
    });

    return res.status(401).json({
      success: false,
      message: "Sessão do afiliado inválida ou expirada.",
    });
  }
}
