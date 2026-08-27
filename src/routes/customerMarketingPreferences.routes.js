import express from "express";
import rateLimit from "express-rate-limit";

import {
  optionalCustomerAuth,
  requireCustomerAuth,
} from "./storeCustomerAccount.routes.js";
import {
  linkCustomerVisitor,
  refreshCustomerInterestProfile,
  refreshVisitorInterestProfile,
  verifyVisitorSession,
} from "../services/customerInterestProfile.service.js";
import {
  suppressCustomerProductMarketing,
  verifyProductInterestUnsubscribeToken,
} from "../services/productInterestNotification.service.js";
import {
  deactivateCustomerMarketingPushSubscription,
  saveCustomerMarketingPushSubscription,
} from "../services/customerMarketingPush.service.js";

const router = express.Router();

const marketingPreferenceLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  skip(req) {
    return req.method === "OPTIONS";
  },
  message: {
    success: false,
    message: "Muitas solicitações. Aguarde alguns minutos e tente novamente.",
  },
});

router.use(marketingPreferenceLimiter);

function cleanIdentifier(value, maxLength = 180) {
  const text = String(value || "").trim();
  return text ? text.slice(0, maxLength) : "";
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderUnsubscribePage({ token, completed = false, invalid = false } = {}) {
  const title = invalid
    ? "Link inválido"
    : completed
      ? "Novidades canceladas"
      : "Cancelar novidades por e-mail";
  const description = invalid
    ? "Este link é inválido ou expirou."
    : completed
      ? "Você não receberá mais novidades personalizadas por e-mail da OZONTECK."
      : "Confirme para deixar de receber novidades personalizadas por e-mail.";
  const action = token
    ? `/api/store/customer/marketing/unsubscribe?token=${encodeURIComponent(token)}`
    : "";
  const form =
    !invalid && !completed && action
      ? `<form method="post" action="${escapeHtml(action)}"><button type="submit" style="border:0;border-radius:10px;background:#111827;color:#fff;padding:12px 18px;font-weight:700;cursor:pointer;">Confirmar cancelamento</button></form>`
      : "";

  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(
    title
  )}</title></head><body style="margin:0;background:#f5f5f5;font-family:Arial,Helvetica,sans-serif;color:#111827;"><main style="max-width:560px;margin:60px auto;padding:28px;background:#fff;border:1px solid #e5e7eb;border-radius:14px;"><p style="color:#6b7280;">OZONTECK</p><h1>${escapeHtml(
    title
  )}</h1><p style="line-height:1.6;">${escapeHtml(description)}</p>${form}</main></body></html>`;
}

router.post("/identity", requireCustomerAuth, async (req, res) => {
  try {
    const visitorId = cleanIdentifier(req.body?.visitor_id || req.body?.visitorId);
    const sessionId = cleanIdentifier(req.body?.session_id || req.body?.sessionId);

    if (!visitorId || !sessionId) {
      return res.status(400).json({
        success: false,
        message: "visitor_id e session_id são obrigatórios.",
      });
    }

    await linkCustomerVisitor({
      customerId: req.customerAuth.id,
      visitorId,
      sessionId,
      source: "authenticated_store",
    });

    let profileStatus = "updated";
    try {
      await refreshCustomerInterestProfile(req.customerAuth.id);
    } catch (profileError) {
      profileStatus = "pending";
      console.error("CUSTOMER INTEREST PROFILE REFRESH ERROR:", {
        customerId: req.customerAuth.id,
        code: profileError?.code || null,
        message: profileError?.message || String(profileError),
      });
    }

    return res.status(200).json({
      success: true,
      linked: true,
      profileStatus,
    });
  } catch (error) {
    console.error("CUSTOMER INTEREST IDENTITY LINK ERROR:", {
      customerId: req.customerAuth?.id || null,
      code: error?.code || null,
      message: error?.message || String(error),
    });
    return res.status(Number(error?.statusCode || 500)).json({
      success: false,
      message:
        Number(error?.statusCode) === 400
          ? error.message
          : "Não foi possível vincular o histórico de interesse.",
    });
  }
});

router.post("/push/subscription", optionalCustomerAuth, async (req, res) => {
  try {
    const visitorId = cleanIdentifier(req.body?.visitor_id || req.body?.visitorId);
    const sessionId = cleanIdentifier(req.body?.session_id || req.body?.sessionId);
    const marketingConsent = req.body?.marketing_consent === true;
    const visitorSessionIsValid = await verifyVisitorSession({ visitorId, sessionId });
    if (!visitorSessionIsValid) {
      return res.status(400).json({
        success: false,
        subscribed: false,
        message: "A sessão de navegação é inválida ou ainda não foi registrada.",
      });
    }

    if (!req.customerAuth && !marketingConsent) {
      return res.status(403).json({
        success: false,
        subscribed: false,
        message: "Confirme a ativação das notificações neste navegador.",
      });
    }

    if (
      req.customerAuth &&
      req.customer?.newsletter_opt_in !== true &&
      !marketingConsent
    ) {
      return res.status(403).json({
        success: false,
        subscribed: false,
        message:
          "Ative o recebimento de novidades na sua conta para permitir notificações de lançamentos.",
      });
    }

    if (req.customerAuth) {
      await linkCustomerVisitor({
        customerId: req.customerAuth.id,
        visitorId,
        sessionId,
        source: "push_subscription",
      });
    }

    const subscription = await saveCustomerMarketingPushSubscription({
      customerId: req.customerAuth?.id || null,
      visitorId,
      sessionId,
      subscription: req.body?.subscription,
      userAgent: req.get("user-agent") || "",
      marketingConsent,
    });

    let profileStatus = "updated";
    try {
      if (req.customerAuth) {
        await refreshCustomerInterestProfile(req.customerAuth.id);
      } else {
        await refreshVisitorInterestProfile(visitorId);
      }
    } catch (profileError) {
      profileStatus = "pending";
      console.error("MARKETING PUSH PROFILE REFRESH ERROR:", {
        customerId: req.customerAuth?.id || null,
        visitorId,
        code: profileError?.code || null,
        message: profileError?.message || String(profileError),
      });
    }

    const active = subscription?.is_active === true;
    return res.status(200).json({
      success: true,
      subscribed: active,
      suppressed: !active,
      marketingConsentConfirmed: marketingConsent,
      owner: req.customerAuth ? "customer" : "visitor",
      profileStatus,
      subscription: {
        id: subscription?.id || null,
        active,
        consentedAt: subscription?.consented_at || null,
      },
    });
  } catch (error) {
    console.error("CUSTOMER MARKETING PUSH SUBSCRIPTION ERROR:", {
      customerId: req.customerAuth?.id || null,
      code: error?.code || null,
      message: error?.message || String(error),
    });
    return res.status(Number(error?.statusCode || 500)).json({
      success: false,
      message:
        Number(error?.statusCode) === 400
          ? error.message
          : "Não foi possível ativar as notificações no celular.",
    });
  }
});

router.delete("/push/subscription", optionalCustomerAuth, async (req, res) => {
  try {
    const visitorId = cleanIdentifier(req.body?.visitor_id || req.body?.visitorId);
    const sessionId = cleanIdentifier(req.body?.session_id || req.body?.sessionId);
    if (!req.customerAuth) {
      const visitorSessionIsValid = await verifyVisitorSession({ visitorId, sessionId });
      if (!visitorSessionIsValid) {
        return res.status(400).json({
          success: false,
          subscribed: true,
          message: "A sessão de navegação é inválida.",
        });
      }
    }

    await deactivateCustomerMarketingPushSubscription({
      customerId: req.customerAuth?.id || null,
      visitorId,
      endpoint: req.body?.endpoint,
    });

    return res.status(200).json({
      success: true,
      subscribed: false,
    });
  } catch (error) {
    console.error("CUSTOMER MARKETING PUSH UNSUBSCRIBE ERROR:", {
      customerId: req.customerAuth?.id || null,
      code: error?.code || null,
      message: error?.message || String(error),
    });
    return res.status(Number(error?.statusCode || 500)).json({
      success: false,
      message:
        Number(error?.statusCode) === 400
          ? error.message
          : "Não foi possível desativar as notificações no celular.",
    });
  }
});

router.get("/unsubscribe", (req, res) => {
  res.set("Cache-Control", "no-store, max-age=0");
  const token = cleanIdentifier(req.query?.token, 3000);
  try {
    verifyProductInterestUnsubscribeToken(token);
    return res.status(200).type("html").send(renderUnsubscribePage({ token }));
  } catch {
    return res.status(400).type("html").send(renderUnsubscribePage({ invalid: true }));
  }
});

router.post("/unsubscribe", async (req, res) => {
  res.set("Cache-Control", "no-store, max-age=0");
  const token = cleanIdentifier(req.query?.token || req.body?.token, 3000);

  try {
    await suppressCustomerProductMarketing({ token });
    if (req.accepts(["html", "json"]) === "json") {
      return res.status(200).json({
        success: true,
        unsubscribed: true,
        channel: "email",
      });
    }
    return res.status(200).type("html").send(renderUnsubscribePage({ completed: true }));
  } catch (error) {
    console.error("CUSTOMER PRODUCT MARKETING UNSUBSCRIBE ERROR:", {
      code: error?.code || null,
      message: error?.message || String(error),
    });
    if (req.accepts(["html", "json"]) === "json") {
      return res.status(Number(error?.statusCode || 500)).json({
        success: false,
        message:
          Number(error?.statusCode) === 400
            ? "Link de descadastro inválido ou expirado."
            : "Não foi possível concluir o descadastro.",
      });
    }
    return res
      .status(Number(error?.statusCode || 500))
      .type("html")
      .send(renderUnsubscribePage({ invalid: true }));
  }
});

export default router;
