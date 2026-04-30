import {
  getPublicVapidKey,
  saveAffiliatePushSubscription,
  removeAffiliatePushSubscription,
  sendPushToAffiliate,
} from "../services/affiliatePush.service.js";

function ok(res, data = {}, message = "OK") {
  return res.status(200).json({
    success: true,
    message,
    ...data,
  });
}

function fail(res, error, status = 500) {
  return res.status(status).json({
    success: false,
    message: error?.message || "Erro interno.",
  });
}

export async function getPushConfig(req, res) {
  try {
    const publicKey = getPublicVapidKey();

    if (!publicKey) {
      return fail(res, new Error("Chave pública de notificação não configurada."), 500);
    }

    return ok(res, { publicKey });
  } catch (error) {
    return fail(res, error);
  }
}

export async function subscribeAffiliatePush(req, res) {
  try {
    const subscription = req.body?.subscription;

    if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
      return fail(res, new Error("Inscrição de notificação inválida."), 400);
    }

    const saved = await saveAffiliatePushSubscription({
      affiliateId: req.affiliateId,
      subscription,
      userAgent: req.body?.user_agent || req.headers["user-agent"] || "",
    });

    return ok(res, { subscription: saved }, "Notificações ativadas com sucesso.");
  } catch (error) {
    return fail(res, error, 400);
  }
}

export async function unsubscribeAffiliatePush(req, res) {
  try {
    const endpoint = req.body?.endpoint;

    if (!endpoint) {
      return fail(res, new Error("Endpoint não enviado."), 400);
    }

    await removeAffiliatePushSubscription({
      affiliateId: req.affiliateId,
      endpoint,
    });

    return ok(res, {}, "Notificações desativadas com sucesso.");
  } catch (error) {
    return fail(res, error, 400);
  }
}

export async function sendAffiliateTestPush(req, res) {
  try {
    const result = await sendPushToAffiliate(req.affiliateId, {
      title: "🔔 Notificações ativadas",
      body: "Seu app OZONTECK Afiliados já pode receber avisos importantes.",
      url: "/pages-html/afiliado-painel.html",
      tag: "affiliate-test",
    });

    return ok(res, { result }, "Notificação de teste enviada.");
  } catch (error) {
    return fail(res, error, 400);
  }
}
