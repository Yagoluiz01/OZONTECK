import nodemailer from "nodemailer";
import { createAdminNotification } from "./adminNotifications.service.js";

function getAffiliateName(affiliate = {}) {
  return (
    affiliate.full_name ||
    affiliate.name ||
    affiliate.email ||
    affiliate.ref_code ||
    "Afiliado"
  );
}

function formatMoneyBR(value) {
  const number = Number(value || 0);

  return number.toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

function getAffiliateTrainingGroupUrl() {
  return String(process.env.AFFILIATE_TRAINING_GROUP_URL || "").trim();
}

function getEnvValue(...names) {
  for (const name of names) {
    const value = process.env[name];

    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return String(value).trim();
    }
  }

  return "";
}

function isEmailEnabled() {
  const enabled = getEnvValue(
    "NOTIFICATIONS_ENABLED",
    "EMAIL_NOTIFICATIONS_ENABLED",
    "BREVO_NOTIFICATIONS_ENABLED"
  );

  if (!enabled) return true;

  return ["true", "1", "yes", "sim", "on"].includes(enabled.toLowerCase());
}

function getSmtpConfig() {
  const host =
    getEnvValue("SMTP_HOST", "BREVO_SMTP_HOST") || "smtp-relay.brevo.com";

  const port = Number(getEnvValue("SMTP_PORT", "BREVO_SMTP_PORT") || 587);

  const user = getEnvValue(
    "SMTP_USER",
    "SMTP_USERNAME",
    "BREVO_SMTP_USER",
    "BREVO_USER"
  );

  const pass = getEnvValue(
    "SMTP_PASS",
    "SMTP_PASSWORD",
    "BREVO_SMTP_PASS",
    "BREVO_SMTP_PASSWORD",
    "BREVO_API_KEY"
  );

  const fromEmail = getEnvValue(
    "SMTP_FROM_EMAIL",
    "BREVO_FROM_EMAIL",
    "MAIL_FROM_EMAIL",
    "FROM_EMAIL"
  );

  const fromName =
    getEnvValue(
      "SMTP_FROM_NAME",
      "BREVO_FROM_NAME",
      "MAIL_FROM_NAME",
      "FROM_NAME"
    ) || "OZONTECK";

  return {
    host,
    port,
    secure: port === 465,
    user,
    pass,
    fromEmail,
    fromName,
  };
}

function getAdminNotificationEmail() {
  return getEnvValue(
    "ADMIN_NOTIFICATION_EMAIL",
    "ADMIN_EMAIL",
    "SMTP_ADMIN_EMAIL",
    "BREVO_ADMIN_EMAIL"
  );
}

function hasSmtpConfig(config) {
  return Boolean(
    config &&
      config.host &&
      config.port &&
      config.user &&
      config.pass &&
      config.fromEmail
  );
}

let transporterCache = null;
let transporterCacheKey = "";

function getTransporter() {
  const config = getSmtpConfig();

  if (!hasSmtpConfig(config)) {
    return {
      transporter: null,
      config,
      reason: "smtp_not_configured",
    };
  }

  const cacheKey = [
    config.host,
    config.port,
    config.secure,
    config.user,
    config.fromEmail,
  ].join("|");

  if (transporterCache && transporterCacheKey === cacheKey) {
    return {
      transporter: transporterCache,
      config,
      reason: null,
    };
  }

  transporterCache = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: {
      user: config.user,
      pass: config.pass,
    },
  });

  transporterCacheKey = cacheKey;

  return {
    transporter: transporterCache,
    config,
    reason: null,
  };
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function buildHtmlEmail({ title, greeting, lines = [], actionUrl, actionLabel }) {
  const safeTitle = escapeHtml(title);
  const safeGreeting = escapeHtml(greeting);

  const lineHtml = lines
    .filter((line) => line !== undefined && line !== null && String(line).trim() !== "")
    .map(
      (line) =>
        `<p style="margin:0 0 12px;color:#334155;font-size:15px;line-height:1.6;">${escapeHtml(
          line
        )}</p>`
    )
    .join("");

  const buttonHtml =
    actionUrl && actionLabel
      ? `
        <div style="margin:24px 0;">
          <a href="${escapeHtml(actionUrl)}"
             target="_blank"
             rel="noopener noreferrer"
             style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:12px;font-weight:700;font-size:14px;">
            ${escapeHtml(actionLabel)}
          </a>
        </div>
      `
      : "";

  return `
    <!doctype html>
    <html lang="pt-BR">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>${safeTitle}</title>
      </head>
      <body style="margin:0;padding:0;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f1f5f9;padding:28px 12px;">
          <tr>
            <td align="center">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:620px;background:#ffffff;border-radius:18px;overflow:hidden;border:1px solid #e2e8f0;">
                <tr>
                  <td style="background:#111827;padding:24px;">
                    <h1 style="margin:0;color:#ffffff;font-size:22px;line-height:1.3;">${safeTitle}</h1>
                    <p style="margin:8px 0 0;color:#cbd5e1;font-size:14px;">Sistema OZONTECK</p>
                  </td>
                </tr>
                <tr>
                  <td style="padding:26px 24px;">
                    <p style="margin:0 0 16px;color:#0f172a;font-size:17px;font-weight:700;">${safeGreeting}</p>
                    ${lineHtml}
                    ${buttonHtml}
                    <p style="margin:24px 0 0;color:#64748b;font-size:13px;line-height:1.6;">
                      Esta é uma mensagem automática da OZONTECK.
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </body>
    </html>
  `;
}

async function sendBrevoEmail({ to, subject, text, html }) {
  try {
    if (!isEmailEnabled()) {
      console.log("BREVO EMAIL SKIPPED:", {
        reason: "email_notifications_disabled",
        to,
        subject,
      });

      return {
        success: false,
        skipped: true,
        reason: "email_notifications_disabled",
      };
    }

    const safeTo = String(to || "").trim();

    if (!safeTo) {
      console.log("BREVO EMAIL SKIPPED:", {
        reason: "missing_recipient",
        subject,
      });

      return {
        success: false,
        skipped: true,
        reason: "missing_recipient",
      };
    }

    const { transporter, config, reason } = getTransporter();

    if (!transporter) {
      console.log("BREVO EMAIL SKIPPED:", {
        reason,
        hasHost: Boolean(config.host),
        hasPort: Boolean(config.port),
        hasUser: Boolean(config.user),
        hasPass: Boolean(config.pass),
        hasFromEmail: Boolean(config.fromEmail),
        to: safeTo,
        subject,
      });

      return {
        success: false,
        skipped: true,
        reason,
      };
    }

    const info = await transporter.sendMail({
      from: `"${config.fromName}" <${config.fromEmail}>`,
      to: safeTo,
      subject,
      text,
      html,
    });

    console.log("BREVO EMAIL SENT:", {
      to: safeTo,
      subject,
      messageId: info?.messageId || null,
    });

    return {
      success: true,
      skipped: false,
      messageId: info?.messageId || null,
    };
  } catch (error) {
    console.error("BREVO EMAIL ERROR:", {
      to,
      subject,
      message: error?.message,
      code: error?.code,
      command: error?.command,
      response: error?.response,
    });

    return {
      success: false,
      skipped: false,
      reason: "send_failed",
      error: error?.message || "Erro desconhecido ao enviar email.",
    };
  }
}

async function safeCreateAdminNotification(payload) {
  try {
    return await createAdminNotification(payload);
  } catch (error) {
    console.error("ADMIN NOTIFICATION ERROR:", {
      type: payload?.type,
      title: payload?.title,
      message: error?.message,
    });

    return null;
  }
}

async function notifyAdminByEmail({ subject, title, lines = [] }) {
  const adminEmail = getAdminNotificationEmail();

  if (!adminEmail) {
    return {
      success: false,
      skipped: true,
      reason: "admin_email_not_configured",
    };
  }

  return sendBrevoEmail({
    to: adminEmail,
    subject,
    text: [title, ...lines].filter(Boolean).join("\n\n"),
    html: buildHtmlEmail({
      title,
      greeting: "Olá, administrador.",
      lines,
    }),
  });
}

export async function notifyAffiliateCreated(application = {}) {
  const adminNotification = await safeCreateAdminNotification({
    type: "affiliate_application_created",
    title: "Nova solicitação de afiliado",
    message: `${getAffiliateName(application)} enviou uma solicitação para ser afiliado.`,
    entity_type: "affiliate_application",
    entity_id: application.id || null,
    priority: "high",
    metadata: {
      full_name: application.full_name || "",
      email: application.email || "",
      phone: application.phone || "",
      status: application.status || "pending",
      desired_ref_code: application.desired_ref_code || "",
      desired_coupon_code: application.desired_coupon_code || "",
      recruiter_ref_code: application.recruiter_ref_code || "",
      recruiter_affiliate_id: application.recruiter_affiliate_id || null,
    },
  });

  await notifyAdminByEmail({
    subject: "Nova solicitação de afiliado - OZONTECK",
    title: "Nova solicitação de afiliado",
    lines: [
      `${getAffiliateName(application)} enviou uma solicitação para ser afiliado.`,
      application.email ? `Email: ${application.email}` : "",
      application.phone ? `Telefone: ${application.phone}` : "",
      application.desired_ref_code
        ? `Código desejado: ${application.desired_ref_code}`
        : "",
      application.recruiter_ref_code
        ? `Indicado por: ${application.recruiter_ref_code}`
        : "",
    ],
  });

  return adminNotification;
}

export async function notifyAffiliateCommissionCreated(affiliate = {}, conversion = {}) {
  const commissionAmount = formatMoneyBR(conversion.commission_amount);

  const adminNotification = await safeCreateAdminNotification({
    type: "affiliate_commission_created",
    title: "Comissão de afiliado gerada",
    message: `${getAffiliateName(affiliate)} recebeu uma comissão de ${commissionAmount}.`,
    entity_type: "affiliate_conversion",
    entity_id: conversion.id || null,
    priority: "high",
    metadata: {
      affiliate_id: affiliate.id || conversion.affiliate_id || null,
      affiliate_name: getAffiliateName(affiliate),
      affiliate_email: affiliate.email || "",
      order_id: conversion.order_id || null,
      order_number: conversion.order_number || "",
      conversion_type: conversion.conversion_type || "",
      commission_amount: conversion.commission_amount || 0,
      commission_rate: conversion.commission_rate || 0,
      status: conversion.status || "",
    },
  });

  await notifyAdminByEmail({
    subject: "Comissão de afiliado gerada - OZONTECK",
    title: "Comissão de afiliado gerada",
    lines: [
      `${getAffiliateName(affiliate)} recebeu uma comissão de ${commissionAmount}.`,
      conversion.order_number ? `Pedido: ${conversion.order_number}` : "",
      conversion.conversion_type ? `Tipo: ${conversion.conversion_type}` : "",
      conversion.status ? `Status: ${conversion.status}` : "",
    ],
  });

  if (affiliate.email) {
    await sendBrevoEmail({
      to: affiliate.email,
      subject: "Sua comissão foi gerada - OZONTECK",
      text: [
        `Olá, ${getAffiliateName(affiliate)}.`,
        `Uma nova comissão foi gerada para você no valor de ${commissionAmount}.`,
        conversion.order_number ? `Pedido: ${conversion.order_number}` : "",
        "Acompanhe seu painel de afiliado para mais detalhes.",
      ]
        .filter(Boolean)
        .join("\n\n"),
      html: buildHtmlEmail({
        title: "Sua comissão foi gerada",
        greeting: `Olá, ${getAffiliateName(affiliate)}.`,
        lines: [
          `Uma nova comissão foi gerada para você no valor de ${commissionAmount}.`,
          conversion.order_number ? `Pedido: ${conversion.order_number}` : "",
          "Acompanhe seu painel de afiliado para mais detalhes.",
        ],
      }),
    });
  }

  return adminNotification;
}

export async function notifyAffiliateApproved(affiliate = {}) {
  const trainingGroupUrl = getAffiliateTrainingGroupUrl();

  const adminNotification = await safeCreateAdminNotification({
    type: "affiliate_approved",
    title: "Afiliado aprovado",
    message: trainingGroupUrl
      ? `${getAffiliateName(affiliate)} foi aprovado como afiliado OZONTECK.\n\nGrupo de treinamento: ${trainingGroupUrl}`
      : `${getAffiliateName(affiliate)} foi aprovado como afiliado OZONTECK.`,
    entity_type: "affiliate",
    entity_id: affiliate.id || affiliate.affiliate_id || null,
    priority: "high",
    metadata: {
      affiliate_id: affiliate.id || affiliate.affiliate_id || null,
      full_name: affiliate.full_name || "",
      email: affiliate.email || "",
      phone: affiliate.phone || "",
      ref_code: affiliate.ref_code || "",
      coupon_code: affiliate.coupon_code || "",
      commission_rate: affiliate.commission_rate || 0,
      status: affiliate.status || "active",
      training_group_url: trainingGroupUrl,
    },
  });

  if (affiliate.email) {
    await sendBrevoEmail({
      to: affiliate.email,
      subject: "Você foi aprovado como afiliado OZONTECK",
      text: [
        `Olá, ${getAffiliateName(affiliate)}.`,
        "Parabéns! Seu cadastro como afiliado OZONTECK foi aprovado.",
        affiliate.ref_code ? `Seu código de afiliado: ${affiliate.ref_code}` : "",
        affiliate.coupon_code ? `Seu cupom: ${affiliate.coupon_code}` : "",
        trainingGroupUrl
          ? `Entre no grupo de treinamento: ${trainingGroupUrl}`
          : "",
        "Agora você já pode começar sua jornada como afiliado OZONTECK.",
      ]
        .filter(Boolean)
        .join("\n\n"),
      html: buildHtmlEmail({
        title: "Você foi aprovado como afiliado OZONTECK",
        greeting: `Olá, ${getAffiliateName(affiliate)}.`,
        lines: [
          "Parabéns! Seu cadastro como afiliado OZONTECK foi aprovado.",
          affiliate.ref_code ? `Seu código de afiliado: ${affiliate.ref_code}` : "",
          affiliate.coupon_code ? `Seu cupom: ${affiliate.coupon_code}` : "",
          "Agora você já pode começar sua jornada como afiliado OZONTECK.",
        ],
        actionUrl: trainingGroupUrl,
        actionLabel: trainingGroupUrl ? "Entrar no grupo de treinamento" : "",
      }),
    });
  }

  return adminNotification;
}

export async function notifyAffiliatePayoutPaid(affiliate = {}, payout = {}) {
  const amount = formatMoneyBR(
    payout.amount || payout.paid_amount || payout.total_amount
  );

  const adminNotification = await safeCreateAdminNotification({
    type: "affiliate_payout_paid",
    title: "Comissão de afiliado paga",
    message: `${getAffiliateName(affiliate)} teve pagamento de comissão registrado no valor de ${amount}.`,
    entity_type: "affiliate_payout",
    entity_id: payout.id || null,
    priority: "high",
    metadata: {
      affiliate_id: affiliate.id || affiliate.affiliate_id || payout.affiliate_id || null,
      affiliate_name: getAffiliateName(affiliate),
      affiliate_email: affiliate.email || "",
      payout_id: payout.id || null,
      amount: payout.amount || payout.paid_amount || payout.total_amount || 0,
      payment_reference: payout.payment_reference || "",
      receipt_url: payout.receipt_url || payout.receipt_path || "",
      status: payout.status || "paid",
      paid_at: payout.paid_at || payout.created_at || "",
    },
  });

  if (affiliate.email) {
    await sendBrevoEmail({
      to: affiliate.email,
      subject: "Pagamento de comissão registrado - OZONTECK",
      text: [
        `Olá, ${getAffiliateName(affiliate)}.`,
        `Seu pagamento de comissão foi registrado no valor de ${amount}.`,
        payout.payment_reference
          ? `Referência do pagamento: ${payout.payment_reference}`
          : "",
        payout.paid_at || payout.created_at
          ? `Data: ${payout.paid_at || payout.created_at}`
          : "",
        "Obrigado por fazer parte da OZONTECK.",
      ]
        .filter(Boolean)
        .join("\n\n"),
      html: buildHtmlEmail({
        title: "Pagamento de comissão registrado",
        greeting: `Olá, ${getAffiliateName(affiliate)}.`,
        lines: [
          `Seu pagamento de comissão foi registrado no valor de ${amount}.`,
          payout.payment_reference
            ? `Referência do pagamento: ${payout.payment_reference}`
            : "",
          payout.paid_at || payout.created_at
            ? `Data: ${payout.paid_at || payout.created_at}`
            : "",
          "Obrigado por fazer parte da OZONTECK.",
        ],
      }),
    });
  }

  return adminNotification;
}

export async function notifyAffiliateRejected(application = {}) {
  const adminNotification = await safeCreateAdminNotification({
    type: "affiliate_rejected",
    title: "Solicitação de afiliado recusada",
    message: `${getAffiliateName(application)} teve a solicitação de afiliado recusada.`,
    entity_type: "affiliate_application",
    entity_id: application.id || null,
    priority: "normal",
    metadata: {
      application_id: application.id || null,
      full_name: application.full_name || "",
      email: application.email || "",
      phone: application.phone || "",
      status: application.status || "rejected",
      desired_ref_code: application.desired_ref_code || "",
      desired_coupon_code: application.desired_coupon_code || "",
      rejected_at: application.rejected_at || application.updated_at || "",
    },
  });

  if (application.email) {
    await sendBrevoEmail({
      to: application.email,
      subject: "Atualização da sua solicitação de afiliado - OZONTECK",
      text: [
        `Olá, ${getAffiliateName(application)}.`,
        "Sua solicitação para participar do programa de afiliados OZONTECK foi analisada.",
        "Neste momento, ela não foi aprovada.",
        "Você poderá tentar novamente futuramente seguindo as orientações da equipe.",
      ].join("\n\n"),
      html: buildHtmlEmail({
        title: "Atualização da sua solicitação de afiliado",
        greeting: `Olá, ${getAffiliateName(application)}.`,
        lines: [
          "Sua solicitação para participar do programa de afiliados OZONTECK foi analisada.",
          "Neste momento, ela não foi aprovada.",
          "Você poderá tentar novamente futuramente seguindo as orientações da equipe.",
        ],
      }),
    });
  }

  return adminNotification;
}

export async function notifyAffiliatePasswordReset(affiliate = {}) {
  const adminNotification = await safeCreateAdminNotification({
    type: "affiliate_password_reset",
    title: "Senha de afiliado redefinida",
    message: `${getAffiliateName(affiliate)} redefiniu ou solicitou redefinição de senha no painel de afiliado.`,
    entity_type: "affiliate",
    entity_id: affiliate.id || affiliate.affiliate_id || null,
    priority: "normal",
    metadata: {
      affiliate_id: affiliate.id || affiliate.affiliate_id || null,
      full_name: affiliate.full_name || "",
      email: affiliate.email || "",
      phone: affiliate.phone || "",
      ref_code: affiliate.ref_code || "",
      status: affiliate.status || "",
      reset_at: affiliate.reset_at || affiliate.updated_at || new Date().toISOString(),
    },
  });

  await notifyAdminByEmail({
    subject: "Senha de afiliado redefinida - OZONTECK",
    title: "Senha de afiliado redefinida",
    lines: [
      `${getAffiliateName(affiliate)} redefiniu ou solicitou redefinição de senha no painel de afiliado.`,
      affiliate.email ? `Email: ${affiliate.email}` : "",
      affiliate.ref_code ? `Código: ${affiliate.ref_code}` : "",
    ],
  });

  return adminNotification;
}