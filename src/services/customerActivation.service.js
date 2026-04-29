import { env } from "../config/env.js";

const ACTIVATION_MIN_SUBTOTAL = 150;

function toNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function cleanText(value) {
  return String(value || "").trim();
}

function onlyDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

function normalizePhoneForWhatsapp(value) {
  const digits = onlyDigits(value);

  if (!digits) {
    return "";
  }

  // Se já vier com DDI do Brasil, mantém.
  if (digits.startsWith("55") && digits.length >= 12) {
    return digits;
  }

  // Se vier telefone brasileiro sem DDI, adiciona 55.
  if (digits.length >= 10 && digits.length <= 11) {
    return `55${digits}`;
  }

  return digits;
}

function buildActivationMessage(order = {}) {
  const customerName = cleanText(order.customer_name) || "Cliente";

  return `Olá, ${customerName}! Tudo certo? 🙌

Aqui é da OZONTECK. Passando para te agradecer pela sua compra e pela confiança em nossa loja.

Vi que seu pedido foi aprovado e, por ter comprado acima de R$ 150,00 em produtos, você liberou uma condição especial: 40% de desconto na sua ativação.

Além disso, depois de ativada, você pode participar do nosso programa de indicação e ter a possibilidade de ganhar dinheiro indicando outras pessoas para conhecerem a OZONTECK, de acordo com as regras do programa.

A ideia é simples: você indica, acompanha seus resultados e pode crescer junto com a nossa marca.

Estamos selecionando clientes que já compraram na loja para conhecerem essa condição antes de abrir para mais pessoas.

Quer que eu te explique em poucos minutos como funciona sua ativação com 40% de desconto?`;

}

function buildWhatsappUrl(phone, message) {
  const normalizedPhone = normalizePhoneForWhatsapp(phone);

  if (!normalizedPhone) {
    return "";
  }

  return `https://wa.me/${normalizedPhone}?text=${encodeURIComponent(message)}`;
}

async function findActivationOfferByOrderId(orderId) {
  if (!orderId) {
    return null;
  }

  const url = new URL(`${env.supabaseUrl}/rest/v1/customer_activation_offers`);
  url.searchParams.set("select", "*");
  url.searchParams.set("order_id", `eq.${orderId}`);
  url.searchParams.set("limit", "1");

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      apikey: env.supabaseServiceRoleKey,
      Authorization: `Bearer ${env.supabaseServiceRoleKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
  });

  const data = await response.json().catch(() => []);

  if (!response.ok || !Array.isArray(data) || !data[0]?.id) {
    return null;
  }

  return data[0];
}

export async function createActivationOfferForPaidOrder(order = {}) {
  try {
    if (!order?.id) {
      return {
        success: true,
        created: false,
        skipped: true,
        reason: "order_without_id",
      };
    }

    const paymentStatus = cleanText(order.payment_status).toLowerCase();
    const subtotal = toNumber(order.subtotal, 0);

    if (paymentStatus !== "paid") {
      return {
        success: true,
        created: false,
        skipped: true,
        reason: "order_not_paid",
      };
    }

    if (subtotal < ACTIVATION_MIN_SUBTOTAL) {
      return {
        success: true,
        created: false,
        skipped: true,
        reason: "subtotal_below_activation_minimum",
        subtotal,
        minimum: ACTIVATION_MIN_SUBTOTAL,
      };
    }

    const existingOffer = await findActivationOfferByOrderId(order.id);

    if (existingOffer) {
      return {
        success: true,
        created: false,
        skipped: true,
        reason: "activation_offer_already_exists",
        offer: existingOffer,
      };
    }

    const message = buildActivationMessage(order);
    const whatsappUrl = buildWhatsappUrl(order.customer_phone, message);

    const payload = {
      order_id: order.id,
      order_number: cleanText(order.order_number),

      customer_name: cleanText(order.customer_name) || "Cliente",
      customer_email: cleanText(order.customer_email).toLowerCase(),
      customer_phone: cleanText(order.customer_phone),

      total_amount: subtotal,

      offer_type: "mlm_activation",
      offer_status: "recruit_for_activation",
      message_status: "pending",

      whatsapp_message: message,
      whatsapp_url: whatsappUrl,

      paid_at: order.paid_at || new Date().toISOString(),
      notes: `Condição criada automaticamente para pedido pago com subtotal de produtos igual ou acima de R$ ${ACTIVATION_MIN_SUBTOTAL.toFixed(2)}.`,
    };

    const response = await fetch(
      `${env.supabaseUrl}/rest/v1/customer_activation_offers`,
      {
        method: "POST",
        headers: {
          apikey: env.supabaseServiceRoleKey,
          Authorization: `Bearer ${env.supabaseServiceRoleKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          Prefer: "return=representation",
        },
        body: JSON.stringify(payload),
      }
    );

    const data = await response.json().catch(() => []);

    if (!response.ok || !Array.isArray(data) || !data[0]?.id) {
      console.error("ERRO AO CRIAR CONDIÇÃO DE ATIVAÇÃO:", data);

      return {
        success: false,
        created: false,
        skipped: false,
        reason: "supabase_insert_error",
        details: data,
      };
    }

    return {
      success: true,
      created: true,
      skipped: false,
      offer: data[0],
    };
  } catch (error) {
    console.error("ERRO INTERNO NA CONDIÇÃO DE ATIVAÇÃO:", error);

    return {
      success: false,
      created: false,
      skipped: false,
      reason: "internal_error",
      error: error.message || String(error),
    };
  }
}

export async function markActivationOfferAsContacted(offerId) {
  if (!offerId) {
    throw new Error("ID da condição de ativação não informado.");
  }

  const url = new URL(`${env.supabaseUrl}/rest/v1/customer_activation_offers`);
  url.searchParams.set("id", `eq.${offerId}`);

  const response = await fetch(url.toString(), {
    method: "PATCH",
    headers: {
      apikey: env.supabaseServiceRoleKey,
      Authorization: `Bearer ${env.supabaseServiceRoleKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify({
      offer_status: "contacted",
      message_status: "sent",
      sent_at: new Date().toISOString(),
    }),
  });

  const data = await response.json().catch(() => []);

  if (!response.ok || !Array.isArray(data) || !data[0]?.id) {
    throw new Error("Erro ao marcar condição como mensagem enviada.");
  }

  return data[0];
}

export async function markActivationOfferAsAccepted(offerId) {
  if (!offerId) {
    throw new Error("ID da condição de ativação não informado.");
  }

  const url = new URL(`${env.supabaseUrl}/rest/v1/customer_activation_offers`);
  url.searchParams.set("id", `eq.${offerId}`);

  const response = await fetch(url.toString(), {
    method: "PATCH",
    headers: {
      apikey: env.supabaseServiceRoleKey,
      Authorization: `Bearer ${env.supabaseServiceRoleKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify({
      offer_status: "accepted",
      accepted_at: new Date().toISOString(),
    }),
  });

  const data = await response.json().catch(() => []);

  if (!response.ok || !Array.isArray(data) || !data[0]?.id) {
    throw new Error("Erro ao marcar condição como aceita.");
  }

  return data[0];
}

export async function markActivationOfferAsRejected(offerId) {
  if (!offerId) {
    throw new Error("ID da condição de ativação não informado.");
  }

  const url = new URL(`${env.supabaseUrl}/rest/v1/customer_activation_offers`);
  url.searchParams.set("id", `eq.${offerId}`);

  const response = await fetch(url.toString(), {
    method: "PATCH",
    headers: {
      apikey: env.supabaseServiceRoleKey,
      Authorization: `Bearer ${env.supabaseServiceRoleKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify({
      offer_status: "rejected",
      rejected_at: new Date().toISOString(),
    }),
  });

  const data = await response.json().catch(() => []);

  if (!response.ok || !Array.isArray(data) || !data[0]?.id) {
    throw new Error("Erro ao marcar condição como recusada.");
  }

  return data[0];
}