import nodemailer from "nodemailer";

export function getEmailEnvValue(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return String(value).trim();
    }
  }

  return "";
}

function cleanEmailHeaderText(value, maxLength = 120) {
  return String(value || "")
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, maxLength);
}

export function isEmailNotificationEnabled() {
  const enabled = getEmailEnvValue(
    "NOTIFICATIONS_ENABLED",
    "EMAIL_NOTIFICATIONS_ENABLED",
    "BREVO_NOTIFICATIONS_ENABLED"
  );

  // Compatibilidade: a configuração antiga enviava quando a flag global não existia.
  if (!enabled) return true;
  return ["true", "1", "yes", "sim", "on"].includes(enabled.toLowerCase());
}

export function getSmtpConfig() {
  const host =
    getEmailEnvValue("SMTP_HOST", "BREVO_SMTP_HOST") || "smtp-relay.brevo.com";
  const port = Number(getEmailEnvValue("SMTP_PORT", "BREVO_SMTP_PORT") || 587);
  const user = getEmailEnvValue(
    "SMTP_USER",
    "SMTP_USERNAME",
    "BREVO_SMTP_USER",
    "BREVO_USER"
  );
  const pass = getEmailEnvValue(
    "SMTP_PASS",
    "SMTP_PASSWORD",
    "BREVO_SMTP_PASS",
    "BREVO_SMTP_PASSWORD",
    "BREVO_API_KEY"
  );
  const fromEmail = getEmailEnvValue(
    "SMTP_FROM_EMAIL",
    "BREVO_FROM_EMAIL",
    "MAIL_FROM_EMAIL",
    "FROM_EMAIL"
  );
  const fromName =
    getEmailEnvValue(
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

function hasSmtpConfig(config) {
  return Boolean(
    config?.host &&
      config?.port &&
      config?.user &&
      config?.pass &&
      config?.fromEmail
  );
}

let transporterCache = null;
let transporterCacheKey = "";

function getTransporter() {
  const config = getSmtpConfig();

  if (!hasSmtpConfig(config)) {
    return { transporter: null, config, reason: "smtp_not_configured" };
  }

  const cacheKey = [
    config.host,
    config.port,
    config.secure,
    config.user,
    config.fromEmail,
  ].join("|");

  if (transporterCache && transporterCacheKey === cacheKey) {
    return { transporter: transporterCache, config, reason: null };
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

  return { transporter: transporterCache, config, reason: null };
}

export async function sendSmtpEmail({
  to,
  subject,
  text,
  html,
  headers,
  replyTo,
  fromName,
  respectGlobalToggle = true,
  logLabel = "BREVO EMAIL",
  redactRecipient = false,
} = {}) {
  const logRecipient = redactRecipient
    ? String(to || "").replace(/^(.).+(@.+)$/, "$1***$2")
    : to;

  try {
    if (respectGlobalToggle && !isEmailNotificationEnabled()) {
      console.log(`${logLabel} SKIPPED:`, {
        reason: "email_notifications_disabled",
        to: logRecipient,
        subject,
      });
      return { success: false, skipped: true, reason: "email_notifications_disabled" };
    }

    const safeTo = String(to || "").trim();
    if (!safeTo) {
      console.log(`${logLabel} SKIPPED:`, { reason: "missing_recipient", subject });
      return { success: false, skipped: true, reason: "missing_recipient" };
    }

    const { transporter, config, reason } = getTransporter();
    if (!transporter) {
      console.log(`${logLabel} SKIPPED:`, {
        reason,
        hasHost: Boolean(config.host),
        hasPort: Boolean(config.port),
        hasUser: Boolean(config.user),
        hasPass: Boolean(config.pass),
        hasFromEmail: Boolean(config.fromEmail),
        to: redactRecipient
          ? safeTo.replace(/^(.).+(@.+)$/, "$1***$2")
          : safeTo,
        subject,
      });
      return { success: false, skipped: true, reason };
    }

    const info = await transporter.sendMail({
      from: {
        name: cleanEmailHeaderText(fromName) || config.fromName,
        address: config.fromEmail,
      },
      to: safeTo,
      subject,
      text,
      html,
      ...(headers ? { headers } : {}),
      ...(replyTo ? { replyTo } : {}),
    });

    console.log(`${logLabel} SENT:`, {
      to: redactRecipient
        ? safeTo.replace(/^(.).+(@.+)$/, "$1***$2")
        : safeTo,
      subject,
      messageId: info?.messageId || null,
    });
    return { success: true, skipped: false, messageId: info?.messageId || null };
  } catch (error) {
    console.error(`${logLabel} ERROR:`, {
      to: logRecipient,
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
