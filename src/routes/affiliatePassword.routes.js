import express from "express";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import nodemailer from "nodemailer";
import { createClient } from "@supabase/supabase-js";

const router = express.Router();

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function isStrongPassword(password) {
  return typeof password === 'string' && password.trim().length >= 6;
}

function getStoreBaseUrl() {
  return (
    process.env.STORE_PUBLIC_URL ||
    process.env.STORE_BASE_URL ||
    'https://ozonteck-loja.onrender.com'
  ).replace(/\/+$/, '');
}

function getMailTransporter() {
  return nodemailer.createTransport({
    host: process.env.BREVO_SMTP_HOST || 'smtp-relay.brevo.com',
    port: Number(process.env.BREVO_SMTP_PORT || 587),
    secure: false,
    auth: {
      user: process.env.BREVO_SMTP_USER,
      pass: process.env.BREVO_SMTP_PASS,
    },
  });
}

async function sendResetEmail({ to, name, resetLink }) {
  if (!process.env.BREVO_SMTP_USER || !process.env.BREVO_SMTP_PASS) {
    console.warn('RESET PASSWORD EMAIL: credenciais Brevo ausentes.');
    return;
  }

  const transporter = getMailTransporter();

  const fromEmail = process.env.MAIL_FROM_EMAIL || process.env.BREVO_FROM_EMAIL || process.env.BREVO_SMTP_USER;
  const fromName = process.env.MAIL_FROM_NAME || 'OZONTECK';

  const html = `
    <div style="font-family:Arial,sans-serif;background:#f6f7fb;padding:24px;">
      <div style="max-width:560px;margin:auto;background:#ffffff;border-radius:18px;padding:28px;border:1px solid #e5e7eb;">
        <h2 style="margin:0 0 12px;color:#111827;">Redefinição de senha</h2>

        <p style="font-size:15px;color:#374151;line-height:1.6;">
          Olá${name ? `, <strong>${name}</strong>` : ''}.
        </p>

        <p style="font-size:15px;color:#374151;line-height:1.6;">
          Recebemos uma solicitação para redefinir a senha do seu painel de afiliado OZONTECK.
        </p>

        <div style="text-align:center;margin:28px 0;">
          <a href="${resetLink}" 
             style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;padding:14px 22px;border-radius:12px;font-weight:700;">
            Redefinir minha senha
          </a>
        </div>

        <p style="font-size:14px;color:#6b7280;line-height:1.6;">
          Este link expira em 30 minutos. Se você não solicitou essa alteração, ignore este e-mail.
        </p>

        <p style="font-size:13px;color:#9ca3af;margin-top:22px;">
          OZONTECK — Painel de Afiliados
        </p>
      </div>
    </div>
  `;

  await transporter.sendMail({
    from: `"${fromName}" <${fromEmail}>`,
    to,
    subject: 'Redefinição de senha - Painel de Afiliados OZONTECK',
    html,
  });
}

router.post('/forgot-password', async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);

    if (!email || !email.includes('@')) {
      return res.status(400).json({
        success: false,
        message: 'Informe um e-mail válido.',
      });
    }

    const genericMessage = 'Se este e-mail estiver cadastrado, enviaremos um link para redefinir sua senha.';

    const { data: affiliate, error: affiliateError } = await supabaseAdmin
      .from('affiliates')
      .select('id, full_name, email, status')
      .eq('email', email)
      .maybeSingle();

    if (affiliateError) {
      console.error('FORGOT PASSWORD AFFILIATE QUERY ERROR:', affiliateError);
      return res.status(500).json({
        success: false,
        message: 'Erro ao solicitar redefinição de senha.',
      });
    }

    // Segurança: não revela se o e-mail existe ou não.
    if (!affiliate) {
      return res.json({
        success: true,
        message: genericMessage,
      });
    }

    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = hashToken(rawToken);

    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();

    await supabaseAdmin
      .from('affiliate_password_resets')
      .update({ used_at: new Date().toISOString() })
      .eq('affiliate_id', affiliate.id)
      .is('used_at', null);

    const { error: insertError } = await supabaseAdmin
      .from('affiliate_password_resets')
      .insert({
        affiliate_id: affiliate.id,
        email,
        token_hash: tokenHash,
        expires_at: expiresAt,
        ip_address: req.ip || null,
        user_agent: req.get('user-agent') || null,
      });

    if (insertError) {
      console.error('FORGOT PASSWORD TOKEN INSERT ERROR:', insertError);
      return res.status(500).json({
        success: false,
        message: 'Erro ao gerar link de redefinição.',
      });
    }

    const resetLink = `${getStoreBaseUrl()}/pages-html/afiliado-redefinir-senha.html?token=${rawToken}`;

    await sendResetEmail({
      to: email,
      name: affiliate.full_name,
      resetLink,
    });

    return res.json({
      success: true,
      message: genericMessage,
    });
  } catch (error) {
    console.error('FORGOT PASSWORD ERROR:', error);
    return res.status(500).json({
      success: false,
      message: 'Erro interno ao solicitar redefinição de senha.',
    });
  }
});

router.post('/reset-password', async (req, res) => {
  try {
    const token = String(req.body?.token || '').trim();
    const newPassword = String(req.body?.password || '').trim();

    if (!token) {
      return res.status(400).json({
        success: false,
        message: 'Token não enviado.',
      });
    }

    if (!isStrongPassword(newPassword)) {
      return res.status(400).json({
        success: false,
        message: 'A nova senha precisa ter pelo menos 6 caracteres.',
      });
    }

    const tokenHash = hashToken(token);

    const { data: resetRow, error: resetError } = await supabaseAdmin
      .from('affiliate_password_resets')
      .select('id, affiliate_id, expires_at, used_at')
      .eq('token_hash', tokenHash)
      .maybeSingle();

    if (resetError) {
      console.error('RESET PASSWORD TOKEN QUERY ERROR:', resetError);
      return res.status(500).json({
        success: false,
        message: 'Erro ao validar token.',
      });
    }

    if (!resetRow || resetRow.used_at) {
      return res.status(400).json({
        success: false,
        message: 'Link inválido ou já utilizado.',
      });
    }

    if (new Date(resetRow.expires_at).getTime() < Date.now()) {
      return res.status(400).json({
        success: false,
        message: 'Link expirado. Solicite uma nova redefinição de senha.',
      });
    }

    const passwordHash = await bcrypt.hash(newPassword, 12);

    const { error: updateError } = await supabaseAdmin
      .from('affiliates')
      .update({
        password_hash: passwordHash,
        updated_at: new Date().toISOString(),
      })
      .eq('id', resetRow.affiliate_id);

    if (updateError) {
      console.error('RESET PASSWORD AFFILIATE UPDATE ERROR:', updateError);
      return res.status(500).json({
        success: false,
        message: 'Erro ao atualizar senha.',
      });
    }

    await supabaseAdmin
      .from('affiliate_password_resets')
      .update({ used_at: new Date().toISOString() })
      .eq('id', resetRow.id);

    return res.json({
      success: true,
      message: 'Senha redefinida com sucesso. Você já pode acessar o painel.',
    });
  } catch (error) {
    console.error('RESET PASSWORD ERROR:', error);
    return res.status(500).json({
      success: false,
      message: 'Erro interno ao redefinir senha.',
    });
  }
});

export default router;