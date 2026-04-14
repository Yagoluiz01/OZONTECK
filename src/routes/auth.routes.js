import express from "express";
import jwt from "jsonwebtoken";

import { supabaseAuth } from "../config/supabase.js";
import { env } from "../config/env.js";

const router = express.Router();

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

  const text = await response.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  return {
    ok: response.ok,
    status: response.status,
    data,
  };
}

router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: "E-mail e senha são obrigatórios",
      });
    }

    const normalizedEmail = String(email).trim().toLowerCase();

    const { data: authData, error: authError } =
      await supabaseAuth.auth.signInWithPassword({
        email: normalizedEmail,
        password,
      });

    if (authError || !authData?.user) {
      console.log("AUTH ERROR:", authError);

      return res.status(401).json({
        success: false,
        message: "Credenciais inválidas",
      });
    }

    console.log("AUTH USER ID:", authData.user.id);
    console.log("AUTH USER EMAIL:", authData.user.email);

    const adminLookup = await findAdminByEmail(normalizedEmail);

    console.log("ADMIN LOOKUP STATUS:", adminLookup.status);
    console.log("ADMIN LOOKUP DATA:", adminLookup.data);

    if (!adminLookup.ok) {
      return res.status(500).json({
        success: false,
        message: "Erro ao consultar admins",
      });
    }

    const admin = Array.isArray(adminLookup.data)
      ? adminLookup.data[0]
      : adminLookup.data;

    if (!admin) {
      return res.status(403).json({
        success: false,
        message: "Usuário autenticado, mas sem acesso ao painel",
      });
    }

    if (!admin.is_active) {
      return res.status(403).json({
        success: false,
        message: "Usuário inativo no painel administrativo",
      });
    }

    const token = jwt.sign(
      {
        sub: authData.user.id,
        admin_id: admin.id,
        email: admin.email,
        role: admin.role,
        supabase_access_token: authData.session?.access_token || null,
      },
      env.jwtSecret,
      { expiresIn: "8h" }
    );

    return res.status(200).json({
      success: true,
      message: "Login realizado com sucesso",
      token,
      user: {
        id: admin.id,
        full_name: admin.full_name,
        email: admin.email,
        role: admin.role,
      },
      session: {
        access_token: authData.session?.access_token || null,
        refresh_token: authData.session?.refresh_token || null,
        expires_at: authData.session?.expires_at || null,
      },
    });
  } catch (error) {
    console.error("ERRO NO LOGIN:", error);

    return res.status(500).json({
      success: false,
      message: "Erro ao realizar login",
    });
  }
});

router.get("/me", async (req, res) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        message: "Token não enviado",
      });
    }

    const token = authHeader.split(" ")[1];
    const decoded = jwt.verify(token, env.jwtSecret);

    if (!decoded.supabase_access_token) {
      return res.status(401).json({
        success: false,
        message: "Sessão Supabase ausente",
      });
    }

    const { data: userData, error: userError } =
      await supabaseAuth.auth.getUser(decoded.supabase_access_token);

    if (userError || !userData?.user) {
      console.log("GET USER ERROR:", userError);

      return res.status(401).json({
        success: false,
        message: "Sessão inválida ou expirada",
      });
    }

    const normalizedEmail = String(userData.user.email || "")
      .trim()
      .toLowerCase();

    const adminLookup = await findAdminByEmail(normalizedEmail);

    console.log("ME LOOKUP STATUS:", adminLookup.status);
    console.log("ME LOOKUP DATA:", adminLookup.data);

    if (!adminLookup.ok) {
      return res.status(500).json({
        success: false,
        message: "Erro ao consultar admins",
      });
    }

    const admin = Array.isArray(adminLookup.data)
      ? adminLookup.data[0]
      : adminLookup.data;

    if (!admin) {
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

    return res.status(200).json({
      success: true,
      user: admin,
    });
  } catch (error) {
    console.error("ERRO NO /ME:", error);

    return res.status(401).json({
      success: false,
      message: "Token inválido ou expirado",
    });
  }
});

export default router;