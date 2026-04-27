import nodemailer from "nodemailer";
import { env } from "../config/env.js";


function isEnabled() {
  return String(env.notificationsEnabled || "").toLowerCase() === "true";
}

function hasEmailConfig() {
  return Boolean(env.smtpHost && env.smtpUser && env.smtpPass && env.smtpFromEmail);
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function getAffiliateName(affiliate = {}) {
  return (
    affiliate.full_name ||
    affiliate.fullName ||
    affiliate.name ||
    "Afiliado OZONTECK"
  );
}

function getAffiliateEmail(affiliate = {}) {
  return normalizeEmail(affiliate.email);
}

function getRefCode(affiliate = {}) {
  return String(affiliate.ref_code || affiliate.refCode || "").trim();
}

function getCouponCode(affiliate = {}) {
  return String(affiliate.coupon_code || affiliate.couponCode || "").trim();
}

function getCommissionRate(affiliate = {}) {
  const value = Number(affiliate.commission_rate ?? affiliate.commissionRate ?? 0);

  if (!Number.isFinite(value)) {
    return "0%";
  }

  return `${value.toFixed(2).replace(".", ",")}%`;
}

function formatMoney(value) {
  const number = Number(value || 0);

  if (!Number.isFinite(number)) {
    return "R$ 0,00";
  }

  return number.toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

function buildAffiliateLink(affiliate = {}) {
  const refCode = getRefCode(affiliate);

  const baseUrl =
    env.storeBaseUrl ||
    env.publicStoreUrl ||
    "https://ozonteck-loja.onrender.com/pages-html/index.html";

  try {
    const url = new URL(baseUrl);

    if (!url.pathname || url.pathname === "/") {
      url.pathname = "/pages-html/index.html";
    }

    if (refCode) {
      url.searchParams.set("ref", refCode);
    }

    return url.toString();
  } catch {
    const fallback = "https://ozonteck-loja.onrender.com/pages-html/index.html";

    if (!refCode) {
      return fallback;
    }

    return `${fallback}?ref=${encodeURIComponent(refCode)}`;
  }
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function createTransporter() {
  return nodemailer.createTransport({
    host: env.smtpHost,
    port: Number(env.smtpPort || 587),
    secure: Number(env.smtpPort || 587) === 465,
    auth: {
      user: env.smtpUser,
      pass: env.smtpPass,
    },
  });
}

async function sendAffiliateEmail({
  affiliate,
  type,
  to,
  subject,
  text,
  html,
  attachments = [],
}) {
  const channel = "email";
  const recipient = normalizeEmail(to);

  if (!isEnabled()) {
    console.log("AFFILIATE NOTIFICATION SKIPPED:", {
      type,
      channel,
      reason: "notifications_disabled",
    });

    return {
      sent: false,
      skipped: true,
      reason: "notifications_disabled",
    };
  }

  if (!hasEmailConfig()) {
    console.log("AFFILIATE NOTIFICATION SKIPPED:", {
      type,
      channel,
      reason: "smtp_not_configured",
    });

    return {
      sent: false,
      skipped: true,
      reason: "smtp_not_configured",
    };
  }

  if (!recipient) {
    console.log("AFFILIATE NOTIFICATION SKIPPED:", {
      type,
      channel,
      reason: "missing_recipient",
    });

    return {
      sent: false,
      skipped: true,
      reason: "missing_recipient",
    };
  }

  const transporter = createTransporter();

    await transporter.sendMail({
    from: `"${env.smtpFromName || "OZONTECK"}" <${env.smtpFromEmail}>`,
    to: recipient,
    subject,
    text,
    html,
    attachments,
  });

  console.log("NOTIFICAÇÃO DE AFILIADO ENVIADA:", {
    type,
    channel: "E-mail",
    to: recipient,
    affiliateId: affiliate?.id || null,
    affiliateName: getAffiliateName(affiliate),
  });

  return {
    sent: true,
    skipped: false,
    type,
    channel,
    to: recipient,
  };
}

export async function notifyAffiliateCreated(affiliate) {
  const to = getAffiliateEmail(affiliate);
  const affiliateName = getAffiliateName(affiliate);

  const subject = "Cadastro de afiliado recebido - OZONTECK";

  const text = [
    `Olá, ${affiliateName}.`,
    "",
    "Seu cadastro no programa de afiliados OZONTECK foi recebido com sucesso.",
    "",
    "Nossa equipe irá analisar suas informações e, quando estiver tudo certo, você poderá começar a divulgar seus links de indicação.",
    "",
    "Equipe OZONTECK",
  ].join("\n");

  const html = `
    <div style="font-family: Arial, sans-serif; color: #111827; line-height: 1.6;">
      <h2 style="margin: 0 0 12px;">Cadastro de afiliado recebido</h2>
      <p>Olá, <strong>${escapeHtml(affiliateName)}</strong>.</p>
      <p>Seu cadastro no programa de afiliados <strong>OZONTECK</strong> foi recebido com sucesso.</p>
      <p>Nossa equipe irá analisar suas informações e, quando estiver tudo certo, você poderá começar a divulgar seus links de indicação.</p>
      <p style="margin-top: 24px;">Equipe OZONTECK</p>
    </div>
  `;

  return sendAffiliateEmail({
    affiliate,
    type: "affiliate_created",
    to,
    subject,
    text,
    html,
  });
}

export async function notifyAffiliateApproved(affiliate) {
  const to = getAffiliateEmail(affiliate);
  const affiliateName = getAffiliateName(affiliate);
  const refCode = getRefCode(affiliate);
  const couponCode = getCouponCode(affiliate);
  const commissionRate = getCommissionRate(affiliate);
  const affiliateLink = buildAffiliateLink(affiliate);

  const subject = "Você foi aprovado no programa de afiliados OZONTECK";

  const text = [
    `Olá, ${affiliateName}.`,
    "",
    "Parabéns! Seu cadastro no programa de afiliados OZONTECK foi aprovado.",
    "",
    refCode ? `Seu código de indicação: ${refCode}` : "",
    couponCode ? `Seu cupom: ${couponCode}` : "",
    `Sua comissão: ${commissionRate}`,
    "",
    `Seu link de divulgação: ${affiliateLink}`,
    "",
    "Agora você já pode divulgar a OZONTECK e acompanhar seus resultados pelo painel.",
    "",
    "Equipe OZONTECK",
  ]
    .filter(Boolean)
    .join("\n");

  const html = `
    <div style="font-family: Arial, sans-serif; color: #111827; line-height: 1.6;">
      <h2 style="margin: 0 0 12px;">Afiliado aprovado</h2>
      <p>Olá, <strong>${escapeHtml(affiliateName)}</strong>.</p>
      <p>Parabéns! Seu cadastro no programa de afiliados <strong>OZONTECK</strong> foi aprovado.</p>

      <div style="background: #f3f4f6; padding: 14px; border-radius: 10px; margin: 18px 0;">
        ${refCode ? `<p><strong>Código de indicação:</strong> ${escapeHtml(refCode)}</p>` : ""}
        ${couponCode ? `<p><strong>Cupom:</strong> ${escapeHtml(couponCode)}</p>` : ""}
        <p><strong>Comissão:</strong> ${escapeHtml(commissionRate)}</p>
        <p><strong>Link de divulgação:</strong><br />
          <a href="${escapeHtml(affiliateLink)}" target="_blank">${escapeHtml(affiliateLink)}</a>
        </p>
      </div>

      <p>Agora você já pode divulgar a OZONTECK e acompanhar seus resultados pelo painel.</p>
      <p style="margin-top: 24px;">Equipe OZONTECK</p>
    </div>
  `;

  return sendAffiliateEmail({
    affiliate,
    type: "affiliate_approved",
    to,
    subject,
    text,
    html,
  });
}

export async function notifyAffiliateRejected(application = {}) {
  const affiliate = application;
  const to = getAffiliateEmail(application);
  const affiliateName = getAffiliateName(application);

  const subject = "Atualização sobre sua solicitação de afiliado OZONTECK";

  const text = [
    `Olá, ${affiliateName}.`,
    "",
    "Agradecemos seu interesse em participar do programa de afiliados OZONTECK.",
    "",
    "No momento, sua solicitação não foi aprovada.",
    "",
    "Você pode entrar em contato com nossa equipe caso queira mais informações ou tentar novamente no futuro.",
    "",
    "Equipe OZONTECK",
  ].join("\n");

  const html = `
    <div style="font-family: Arial, sans-serif; color: #111827; line-height: 1.6;">
      <h2 style="margin: 0 0 12px;">Atualização sobre sua solicitação</h2>
      <p>Olá, <strong>${escapeHtml(affiliateName)}</strong>.</p>
      <p>Agradecemos seu interesse em participar do programa de afiliados <strong>OZONTECK</strong>.</p>
      <p>No momento, sua solicitação não foi aprovada.</p>
      <p>Você pode entrar em contato com nossa equipe caso queira mais informações ou tentar novamente no futuro.</p>
      <p style="margin-top: 24px;">Equipe OZONTECK</p>
    </div>
  `;

  return sendAffiliateEmail({
    affiliate,
    type: "affiliate_rejected",
    to,
    subject,
    text,
    html,
  });
}

export async function notifyAffiliatePayoutPaid(affiliate, payout = {}, receiptFile = null) {
  const to = getAffiliateEmail(affiliate);
  const affiliateName = getAffiliateName(affiliate);
  const amount = formatMoney(payout.amount);

  const subject = "Pagamento de comissão registrado - OZONTECK";

  const text = [
    `Olá, ${affiliateName}.`,
    "",
    `Registramos o pagamento da sua comissão no valor de ${amount}.`,
    "",
    payout.payment_method ? `Método de pagamento: ${payout.payment_method}` : "",
    payout.payment_reference ? `Referência: ${payout.payment_reference}` : "",
    receiptFile ? "O comprovante do pagamento está anexado neste e-mail." : "",
    "",
    "Obrigado por fazer parte do programa de afiliados OZONTECK.",
    "",
    "Equipe OZONTECK",
  ]
    .filter(Boolean)
    .join("\n");

  const html = `
    <div style="font-family: Arial, sans-serif; color: #111827; line-height: 1.6;">
      <h2 style="margin: 0 0 12px;">Pagamento de comissão registrado</h2>
      <p>Olá, <strong>${escapeHtml(affiliateName)}</strong>.</p>
      <p>Registramos o pagamento da sua comissão no valor de <strong>${escapeHtml(amount)}</strong>.</p>

      ${
        payout.payment_method
          ? `<p><strong>Método de pagamento:</strong> ${escapeHtml(payout.payment_method)}</p>`
          : ""
      }

      ${
        payout.payment_reference
          ? `<p><strong>Referência:</strong> ${escapeHtml(payout.payment_reference)}</p>`
          : ""
      }

      ${
        receiptFile
          ? `<p>O comprovante do pagamento está anexado neste e-mail.</p>`
          : ""
      }

      <p>Obrigado por fazer parte do programa de afiliados OZONTECK.</p>
      <p style="margin-top: 24px;">Equipe OZONTECK</p>
    </div>
  `;

  const attachments = [];

  if (receiptFile?.buffer?.length) {
    attachments.push({
      filename: receiptFile.originalname || "comprovante-comissao",
      content: receiptFile.buffer,
      contentType: receiptFile.mimetype || "application/octet-stream",
    });
  }

  return sendAffiliateEmail({
    affiliate,
    type: "affiliate_payout_paid",
    to,
    subject,
    text,
    html,
    attachments,
  });
}





export async function notifyAffiliateCommissionCreated(affiliate, conversion = {}) {
  const to = getAffiliateEmail(affiliate);
  const affiliateName = getAffiliateName(affiliate);
  const amount = formatMoney(conversion.commission_amount);
  const orderNumber = conversion.order_number || conversion.orderNumber || "pedido indicado";

  const subject = "Nova comissão gerada - OZONTECK";

  const text = [
    `Olá, ${affiliateName}.`,
    "",
    `Uma nova comissão foi gerada para você no programa de afiliados OZONTECK.`,
    "",
    `Pedido: ${orderNumber}`,
    `Valor da comissão: ${amount}`,
    "",
    "Essa comissão ficará disponível conforme as regras de aprovação e pagamento do programa.",
    "",
    "Equipe OZONTECK",
  ].join("\n");

  const html = `
    <div style="font-family: Arial, sans-serif; color: #111827; line-height: 1.6;">
      <h2 style="margin: 0 0 12px;">Nova comissão gerada</h2>
      <p>Olá, <strong>${escapeHtml(affiliateName)}</strong>.</p>
      <p>Uma nova comissão foi gerada para você no programa de afiliados <strong>OZONTECK</strong>.</p>

      <div style="background: #f3f4f6; padding: 14px; border-radius: 10px; margin: 18px 0;">
        <p><strong>Pedido:</strong> ${escapeHtml(orderNumber)}</p>
        <p><strong>Valor da comissão:</strong> ${escapeHtml(amount)}</p>
      </div>

      <p>Essa comissão ficará disponível conforme as regras de aprovação e pagamento do programa.</p>
      <p style="margin-top: 24px;">Equipe OZONTECK</p>
    </div>
  `;

  return sendAffiliateEmail({
    affiliate,
    type: "affiliate_commission_created",
    to,
    subject,
    text,
    html,
  });
}