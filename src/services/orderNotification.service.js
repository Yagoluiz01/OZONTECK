import nodemailer from "nodemailer";
import { env } from "../config/env.js";
import { supabaseAdmin } from "../config/supabase.js";

function isEnabled() {
  return String(env.notificationsEnabled || "").toLowerCase() === "true";
}

function hasEmailConfig() {
  return Boolean(env.smtpHost && env.smtpUser && env.smtpPass && env.smtpFromEmail);
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function getCustomerEmail(order) {
  return normalizeEmail(
    order?.customer_email ||
      order?.email ||
      order?.customer?.email ||
      order?.shipping_email
  );
}

function getCustomerName(order) {
  return (
    order?.customer_name ||
    order?.name ||
    order?.customer?.full_name ||
    order?.customer?.name ||
    "cliente"
  );
}

function getOrderNumber(order) {
  return order?.order_number || order?.orderNumber || order?.id || "";
}

function getOrderTotal(order) {
  const value = Number(order?.total_amount || order?.total || 0);

  if (!Number.isFinite(value) || value <= 0) {
    return "";
  }

  return value.toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL"
  });
}

function createTransporter() {
  return nodemailer.createTransport({
    host: env.smtpHost,
    port: env.smtpPort,
    secure: Number(env.smtpPort) === 465,
    auth: {
      user: env.smtpUser,
      pass: env.smtpPass
    }
  });
}

async function alreadySent(orderId, type, channel) {
  if (!orderId) return false;

  const { data, error } = await supabaseAdmin
    .from("order_notifications")
    .select("id")
    .eq("order_id", orderId)
    .eq("type", type)
    .eq("channel", channel)
    .maybeSingle();

  if (error) {
    console.error("ORDER NOTIFICATION CHECK ERROR:", error.message);
    return false;
  }

  return Boolean(data?.id);
}

async function registerNotification({
  order,
  type,
  channel,
  recipient,
  status = "sent",
  errorMessage = null
}) {
  if (!order?.id) return;

  const payload = {
    order_id: order.id,
    order_number: getOrderNumber(order),
    type,
    channel,
    recipient,
    status,
    error_message: errorMessage
  };

  const { error } = await supabaseAdmin
    .from("order_notifications")
    .insert(payload);

  if (error && !String(error.message || "").includes("duplicate")) {
    console.error("ORDER NOTIFICATION REGISTER ERROR:", error.message);
  }
}

async function sendEmail({ order, type, to, subject, html, text }) {
  const channel = "email";

  if (!isEnabled()) {
    console.log("ORDER NOTIFICATION SKIPPED: notifications disabled", {
      type,
      orderId: order?.id
    });
    return { skipped: true, reason: "disabled" };
  }

  if (!hasEmailConfig()) {
    console.warn("ORDER NOTIFICATION SKIPPED: missing SMTP config", {
      type,
      orderId: order?.id
    });
    return { skipped: true, reason: "missing_smtp_config" };
  }

  if (!to) {
    console.warn("ORDER NOTIFICATION SKIPPED: customer email missing", {
      type,
      orderId: order?.id
    });
    return { skipped: true, reason: "missing_email" };
  }

  const sent = await alreadySent(order?.id, type, channel);

  if (sent) {
    console.log("ORDER NOTIFICATION SKIPPED: already sent", {
      type,
      channel,
      orderId: order?.id
    });
    return { skipped: true, reason: "already_sent" };
  }

  try {
    const transporter = createTransporter();

    await transporter.sendMail({
      from: `"${env.smtpFromName}" <${env.smtpFromEmail}>`,
      to,
      subject,
      text,
      html
    });

    await registerNotification({
      order,
      type,
      channel,
      recipient: to,
      status: "sent"
    });

    console.log("ORDER NOTIFICATION SENT:", {
      type,
      channel,
      to,
      orderId: order?.id,
      orderNumber: getOrderNumber(order)
    });

    return { success: true };
  } catch (error) {
    console.error("ORDER NOTIFICATION EMAIL ERROR:", error);

    await registerNotification({
      order,
      type,
      channel,
      recipient: to,
      status: "failed",
      errorMessage: error.message || "Erro ao enviar e-mail"
    });

    return { success: false, error: error.message };
  }
}

export async function notifyOrderCreatedPending(order) {
  const to = getCustomerEmail(order);
  const customerName = getCustomerName(order);
  const orderNumber = getOrderNumber(order);
  const total = getOrderTotal(order);

  const subject = `Pedido ${orderNumber} criado - aguardando pagamento`;

  const text = [
    `Olá, ${customerName}.`,
    "",
    `Seu pedido ${orderNumber} foi criado com sucesso e está aguardando pagamento.`,
    total ? `Total do pedido: ${total}.` : "",
    "",
    "Assim que o pagamento for confirmado, enviaremos uma nova confirmação automaticamente.",
    "",
    "Equipe OZONTECK"
  ]
    .filter(Boolean)
    .join("\n");

  const html = `
    <div style="font-family: Arial, sans-serif; color: #111827; line-height: 1.6;">
      <h2 style="margin: 0 0 12px;">Pedido criado com sucesso</h2>
      <p>Olá, <strong>${customerName}</strong>.</p>
      <p>Seu pedido <strong>${orderNumber}</strong> foi criado e está <strong>aguardando pagamento</strong>.</p>
      ${total ? `<p><strong>Total:</strong> ${total}</p>` : ""}
      <p>Assim que o pagamento for confirmado, enviaremos uma nova confirmação automaticamente.</p>
      <p style="margin-top: 24px;">Equipe OZONTECK</p>
    </div>
  `;

  return sendEmail({
    order,
    type: "order_created_pending",
    to,
    subject,
    text,
    html
  });
}

export async function notifyOrderPaid(order) {
  const to = getCustomerEmail(order);
  const customerName = getCustomerName(order);
  const orderNumber = getOrderNumber(order);
  const total = getOrderTotal(order);

  const subject = `Pagamento aprovado - pedido ${orderNumber}`;

  const text = [
    `Olá, ${customerName}.`,
    "",
    `Pagamento aprovado! Seu pedido ${orderNumber} foi confirmado com sucesso.`,
    total ? `Total confirmado: ${total}.` : "",
    "",
    "Agora nossa equipe vai preparar o envio. Quando houver atualização de envio ou rastreamento, você será avisado.",
    "",
    "Equipe OZONTECK"
  ]
    .filter(Boolean)
    .join("\n");

  const html = `
    <div style="font-family: Arial, sans-serif; color: #111827; line-height: 1.6;">
      <h2 style="margin: 0 0 12px;">Pagamento aprovado</h2>
      <p>Olá, <strong>${customerName}</strong>.</p>
      <p>Seu pagamento foi aprovado e o pedido <strong>${orderNumber}</strong> foi confirmado com sucesso.</p>
      ${total ? `<p><strong>Total confirmado:</strong> ${total}</p>` : ""}
      <p>Agora nossa equipe vai preparar o envio. Quando houver atualização de envio ou rastreamento, você será avisado.</p>
      <p style="margin-top: 24px;">Equipe OZONTECK</p>
    </div>
  `;

  return sendEmail({
    order,
    type: "order_paid",
    to,
    subject,
    text,
    html
  });
}