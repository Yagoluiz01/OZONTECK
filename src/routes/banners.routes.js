import express from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import {
  listAllBanners,
  listActiveBanners,
  getBanner,
  getBannerStats,
  createBanner,
  updateBanner,
  deleteBanner,
  duplicateBanner,
  reorderBanners,
  trackBannerClick,
  trackBannerView,
} from "../controllers/banners.controller.js";

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

// Rotas públicas (para a loja)
router.get("/active", listActiveBanners);
router.post("/:id/click", trackBannerClick); // Rastreamento de cliques (pública)
router.post("/:id/view", trackBannerView); // Rastreamento de visualizações (pública)

// Rotas administrativas (protegidas)
router.get("/", requireAuth, listAllBanners);
router.post("/", requireAuth, createBanner);
router.patch("/reorder", requireAuth, reorderBanners);
router.get("/:id/stats", requireAuth, getBannerStats);
router.get("/:id", requireAuth, getBanner);
router.put("/:id", requireAuth, updateBanner);
router.delete("/:id", requireAuth, deleteBanner);
router.post("/:id/duplicate", requireAuth, duplicateBanner);

export { requireAuth };
export default router;
