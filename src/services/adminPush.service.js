import webPush from "web-push";
import { supabaseAdmin } from "../config/supabase.js";

const publicKey = String(process.env.VAPID_PUBLIC_KEY || "").trim();
const privateKey = String(process.env.VAPID_PRIVATE_KEY || "").trim();
const subject = String(process.env.VAPID_SUBJECT || "mailto:ozonteck14@gmail.com").trim();

if (publicKey && privateKey) {
  webPush.setVapidDetails(subject, publicKey, privateKey);
}

export function getVapidPublicKey() {
  return publicKey;
}

export async function saveAdminPushSubscription({ admin, subscription, userAgent }) {
  if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    throw new Error("Inscrição push inválida.");
  }

  const payload = {
    admin_id: admin?.id || null,
    admin_email: admin?.email || "",
    endpoint: subscription.endpoint,
    p256dh: subscription.keys.p256dh,
    auth: subscription.keys.auth,
    user_agent: userAgent || "",
    is_active: true,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabaseAdmin
    .from("admin_push_subscriptions")
    .upsert(payload, { onConflict: "endpoint" })
    .select("*")
    .single();

  if (error) {
    console.error("[ADMIN_PUSH_SAVE_ERROR]", error);
    throw new Error(error.message || "Erro ao salvar dispositivo.");
  }

  return data;
}

export async function sendPushToAdmins(notification = {}) {
  if (!publicKey || !privateKey) {
    console.warn("[ADMIN_PUSH] VAPID não configurado.");
    return {
      sent: 0,
      failed: 0,
      skipped: true,
      reason: "vapid_not_configured",
    };
  }

  const { data, error } = await supabaseAdmin
    .from("admin_push_subscriptions")
    .select("*")
    .eq("is_active", true);

  if (error) {
    console.error("[ADMIN_PUSH_LIST_ERROR]", error);
    return {
      sent: 0,
      failed: 0,
      skipped: true,
      reason: "list_error",
    };
  }

  const subscriptions = Array.isArray(data) ? data : [];

  let sent = 0;
  let failed = 0;

  const payload = JSON.stringify({
    title: notification.title || "OZONTECK Admin",
    body: notification.message || notification.body || "Nova notificação no painel.",
    url: resolveNotificationUrl(notification),
  });

  await Promise.all(
    subscriptions.map(async (item) => {
      try {
        await webPush.sendNotification(
          {
            endpoint: item.endpoint,
            keys: {
              p256dh: item.p256dh,
              auth: item.auth,
            },
          },
          payload
        );

        sent += 1;
      } catch (pushError) {
        failed += 1;

        const statusCode = Number(pushError?.statusCode || 0);

        if (statusCode === 404 || statusCode === 410) {
          await supabaseAdmin
            .from("admin_push_subscriptions")
            .update({
              is_active: false,
              updated_at: new Date().toISOString(),
            })
            .eq("id", item.id);
        }

        console.error("[ADMIN_PUSH_SEND_ERROR]", {
          statusCode,
          message: pushError?.message,
        });
      }
    })
  );

  return {
    sent,
    failed,
    skipped: false,
  };
}

function resolveNotificationUrl(notification = {}) {
  const type = String(notification.type || "").toLowerCase();
  const entityType = String(notification.entity_type || "").toLowerCase();

  if (entityType === "order" || type.includes("order") || type.includes("payment")) {
    return "/orders";
  }

  if (
    entityType === "affiliate" ||
    entityType === "affiliate_application" ||
    entityType === "affiliate_conversion" ||
    entityType === "affiliate_payout" ||
    type.includes("affiliate")
  ) {
    return "/affiliates";
  }

  if (type.includes("financial") || type.includes("commission") || type.includes("payout")) {
    return "/financial";
  }

  if (entityType === "customer" || type.includes("customer") || type.includes("client")) {
    return "/customers";
  }

  if (entityType === "product" || type.includes("product") || type.includes("stock")) {
    return "/products";
  }

  return "/dashboard";
}