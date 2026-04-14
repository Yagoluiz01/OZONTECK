import express from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";

const router = express.Router();

async function getUserFromToken(token) {
  const response = await fetch(`${env.supabaseUrl}/auth/v1/user`, {
    method: "GET",
    headers: {
      apikey: env.supabaseAnonKey,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });

  const data = await response.json().catch(() => null);

  return {
    ok: response.ok,
    status: response.status,
    data,
  };
}

async function findAdminByEmail(email) {
  const response = await fetch(`${env.supabaseUrl}/rest/v1/rpc/get_admin_by_email`, {
    method: "POST",
    headers: {
      apikey: env.supabaseServiceRoleKey,
      Authorization: `Bearer ${env.supabaseServiceRoleKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      p_email: email,
    }),
  });

  const data = await response.json().catch(() => null);

  return {
    ok: response.ok,
    status: response.status,
    data,
  };
}

async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        message: "Token não enviado",
      });
    }

    const appToken = authHeader.split(" ")[1];
    const decoded = jwt.verify(appToken, env.jwtSecret);

    if (!decoded.supabase_access_token) {
      return res.status(401).json({
        success: false,
        message: "Sessão inválida",
      });
    }

    const userResponse = await getUserFromToken(decoded.supabase_access_token);

    if (!userResponse.ok || !userResponse.data?.email) {
      return res.status(401).json({
        success: false,
        message: "Sessão expirada ou inválida",
      });
    }

    const normalizedEmail = String(userResponse.data.email).trim().toLowerCase();
    const adminResponse = await findAdminByEmail(normalizedEmail);

    const admin = Array.isArray(adminResponse.data)
      ? adminResponse.data[0]
      : adminResponse.data;

    if (!adminResponse.ok || !admin) {
      return res.status(403).json({
        success: false,
        message: "Usuário sem acesso ao painel",
      });
    }

    if (!admin.is_active) {
      return res.status(403).json({
        success: false,
        message: "Usuário inativo",
      });
    }

    req.auth = {
      admin,
      appToken,
      supabaseAccessToken: decoded.supabase_access_token,
    };

    next();
  } catch {
    return res.status(401).json({
      success: false,
      message: "Token inválido ou expirado",
    });
  }
}

async function callRpc(name, body = {}) {
  const response = await fetch(`${env.supabaseUrl}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: env.supabaseServiceRoleKey,
      Authorization: `Bearer ${env.supabaseServiceRoleKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = await response.json().catch(() => []);

  return {
    ok: response.ok,
    status: response.status,
    data,
  };
}

router.get("/", requireAuth, async (req, res) => {
  try {
    const response = await callRpc("get_store_settings", {});

    if (!response.ok) {
      return res.status(500).json({
        success: false,
        message: "Erro ao buscar configurações",
        details: response.data,
      });
    }

    const settings = Array.isArray(response.data) ? response.data[0] : null;

    if (!settings) {
      return res.status(404).json({
        success: false,
        message: "Configurações não encontradas",
      });
    }

    return res.status(200).json({
      success: true,
      settings,
    });
  } catch (error) {
    console.error("ERRO AO BUSCAR CONFIGURAÇÕES:", error);

    return res.status(500).json({
      success: false,
      message: "Erro interno ao buscar configurações",
    });
  }
});

router.put("/", requireAuth, async (req, res) => {
  try {
    const {
      id,
      store_name,
      store_email,
      whatsapp,
      support_phone,
      base_city,
      base_state,
      currency_code,
      timezone,
      brand_name,
      brand_slogan,
      primary_color,
      secondary_color,
      instagram_url,
      facebook_url,
      tiktok_url,
      whatsapp_url,
      shipping_default_deadline,
      shipping_main_carrier,
      shipping_free_from,
      shipping_main_region,
      payment_pix_status,
      payment_card_status,
      payment_boleto_status,
      payment_installments_max,
      payment_interest_rule,
      payment_gateway,
      privacy_policy,
      exchange_policy,
      terms_of_use,
    } = req.body || {};

    if (!id) {
      return res.status(400).json({
        success: false,
        message: "ID das configurações é obrigatório",
      });
    }

    const response = await callRpc("update_store_settings", {
      p_id: id,
      p_store_name: store_name,
      p_store_email: store_email,
      p_whatsapp: whatsapp,
      p_support_phone: support_phone,
      p_base_city: base_city,
      p_base_state: base_state,
      p_currency_code: currency_code,
      p_timezone: timezone,
      p_brand_name: brand_name,
      p_brand_slogan: brand_slogan,
      p_primary_color: primary_color,
      p_secondary_color: secondary_color,
      p_instagram_url: instagram_url,
      p_facebook_url: facebook_url,
      p_tiktok_url: tiktok_url,
      p_whatsapp_url: whatsapp_url,
      p_shipping_default_deadline: shipping_default_deadline,
      p_shipping_main_carrier: shipping_main_carrier,
      p_shipping_free_from: Number(shipping_free_from || 0),
      p_shipping_main_region: shipping_main_region,
      p_payment_pix_status: payment_pix_status,
      p_payment_card_status: payment_card_status,
      p_payment_boleto_status: payment_boleto_status,
      p_payment_installments_max: payment_installments_max,
      p_payment_interest_rule: payment_interest_rule,
      p_payment_gateway: payment_gateway,
      p_privacy_policy: privacy_policy,
      p_exchange_policy: exchange_policy,
      p_terms_of_use: terms_of_use,
    });

    if (!response.ok) {
      return res.status(500).json({
        success: false,
        message: "Erro ao salvar configurações",
        details: response.data,
      });
    }

    const settings = Array.isArray(response.data) ? response.data[0] : response.data;

    return res.status(200).json({
      success: true,
      message: "Configurações salvas com sucesso",
      settings,
    });
  } catch (error) {
    console.error("ERRO AO SALVAR CONFIGURAÇÕES:", error);

    return res.status(500).json({
      success: false,
      message: "Erro interno ao salvar configurações",
    });
  }
});

export default router;