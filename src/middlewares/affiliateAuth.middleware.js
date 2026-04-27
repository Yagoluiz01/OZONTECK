import {
  getAffiliateById,
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
    const affiliate = await getAffiliateById(decoded.affiliate_id);

    req.affiliate = affiliate;
    req.affiliateId = affiliate.id;

    return next();
  } catch (error) {
    console.error("AFFILIATE AUTH ERROR:", error);

    return res.status(401).json({
      success: false,
      message: "Sessão do afiliado inválida ou expirada.",
    });
  }
}