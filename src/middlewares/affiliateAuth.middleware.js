import {
  assertAffiliateCsrfProtection,
  clearAffiliateSessionCookie,
  getAffiliateSessionTokenFromRequest,
  revokeAffiliateSessionById,
  validateAffiliateSessionToken,
} from "../services/affiliateSession.service.js";
import { getAffiliateSessionById } from "../services/affiliatePortal.service.js";
import {
  isAffiliateLegacyBridgeEnabled,
  verifyAffiliateLegacyBridgeToken,
} from "../services/affiliateLegacyBridge.service.js";

function getBearerToken(req) {
  const authorization = String(
    req.get?.("authorization") || req.headers?.authorization || ""
  ).trim();
  const match = authorization.match(/^Bearer\s+([^\s]+)$/i);
  return match?.[1] || null;
}

async function authenticateLegacyBridge(req) {
  if (!isAffiliateLegacyBridgeEnabled()) return null;

  const bearerToken = getBearerToken(req);
  if (!bearerToken) return null;

  const decoded = verifyAffiliateLegacyBridgeToken(bearerToken);
  const affiliateSession = await getAffiliateSessionById(decoded.affiliate_id);

  if (Number(decoded.auth_version) !== Number(affiliateSession.authVersion)) {
    const error = new Error("Token legado de afiliado revogado.");
    error.statusCode = 401;
    error.code = "AFFILIATE_LEGACY_BRIDGE_TOKEN_REVOKED";
    throw error;
  }

  console.warn("[AFFILIATE_LEGACY_AUTH_BRIDGE_REQUEST]", {
    affiliate_id: affiliateSession.affiliate.id,
    method: req.method,
    path: req.originalUrl || req.url || null,
  });

  return {
    affiliateSession,
    bearerToken,
  };
}

export async function requireAffiliateAuth(req, res, next) {
  try {
    const token = getAffiliateSessionTokenFromRequest(req);

    if (!token) {
      const legacy = await authenticateLegacyBridge(req);
      if (!legacy) {
        clearAffiliateSessionCookie(res);
        return res.status(401).json({
          success: false,
          code: "AFFILIATE_SESSION_MISSING",
          message: "Sessão do afiliado não enviada.",
        });
      }

      req.affiliate = legacy.affiliateSession.affiliate;
      req.affiliateId = legacy.affiliateSession.affiliate.id;
      req.affiliateLegacyBridge = true;
      req.affiliateLegacyBearerToken = legacy.bearerToken;
      return next();
    }

    const session = await validateAffiliateSessionToken(token, { req });
    const affiliateSession = await getAffiliateSessionById(session.affiliate_id);

    if (Number(session.session_version) !== Number(affiliateSession.authVersion)) {
      await revokeAffiliateSessionById(session.id, "auth_version_changed");
      clearAffiliateSessionCookie(res);
      return res.status(401).json({
        success: false,
        code: "AFFILIATE_SESSION_REVOKED",
        message: "Sessão do afiliado revogada.",
      });
    }

    assertAffiliateCsrfProtection(req, session);

    req.affiliate = affiliateSession.affiliate;
    req.affiliateId = affiliateSession.affiliate.id;
    req.affiliateSession = session;
    req.affiliateSessionToken = token;
    req.affiliateCsrfToken = session.csrfToken;

    return next();
  } catch (error) {
    const statusCode = Number(error?.statusCode || 401);

    // Uma falha de CSRF (403) nao torna a sessao autentica invalida.
    // Limpar o cookie aqui causaria logout forcado apos uma requisicao
    // malformada. Apenas falhas de autenticacao da propria sessao (401)
    // devem remover o cookie local.
    if (statusCode === 401) {
      clearAffiliateSessionCookie(res);
    }

    return res.status(statusCode).json({
      success: false,
      code: error?.code || "AFFILIATE_SESSION_INVALID",
      message:
        error?.code === "AFFILIATE_SESSION_REPLACED"
          ? "Um novo login foi realizado nesta conta. Esta sessão foi encerrada."
          : "Sessão do afiliado inválida ou expirada.",
    });
  }
}
