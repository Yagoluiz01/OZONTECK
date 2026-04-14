// customers.routes.js
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

function formatCurrency(value) {
  return Number(value || 0).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

function formatDate(value) {
  if (!value) return "-";

  try {
    return new Date(value).toLocaleDateString("pt-BR");
  } catch {
    return value;
  }
}

router.get("/", requireAuth, async (req, res) => {
  try {
    const search = String(req.query.search || "").trim().toLowerCase();
    const status = String(req.query.status || "all").trim().toLowerCase();
    const origin = String(req.query.origin || "all").trim().toLowerCase();

    const response = await callRpc("get_customers", {});

    if (!response.ok) {
      return res.status(500).json({
        success: false,
        message: "Erro ao buscar clientes",
        details: response.data,
      });
    }

    let customers = Array.isArray(response.data) ? response.data : [];

    if (search) {
      customers = customers.filter((customer) => {
        const fullName = String(customer.full_name || "").toLowerCase();
        const email = String(customer.email || "").toLowerCase();
        const phone = String(customer.phone || "").toLowerCase();

        return (
          fullName.includes(search) ||
          email.includes(search) ||
          phone.includes(search)
        );
      });
    }

    if (status !== "all") {
      customers = customers.filter(
        (customer) => String(customer.status || "").toLowerCase() === status
      );
    }

    if (origin !== "all") {
      customers = customers.filter(
        (customer) => String(customer.origin || "").toLowerCase() === origin
      );
    }

    return res.status(200).json({
      success: true,
      customers: customers.map((customer) => ({
        id: customer.id,
        name: customer.full_name,
        email: customer.email,
        phone: customer.phone || "",
        city: customer.city ? `${customer.city}${customer.state ? ` - ${customer.state}` : ""}` : "-",
        origin: customer.origin || "Site",
        status: customer.status || "lead",
        notes: customer.notes || "",
        totalOrders: Number(customer.total_orders || 0),
        totalSpent: Number(customer.total_spent || 0),
        lastPurchase: formatDate(customer.last_purchase_at),
      })),
    });
  } catch (error) {
    console.error("ERRO AO LISTAR CLIENTES:", error);

    return res.status(500).json({
      success: false,
      message: "Erro interno ao listar clientes",
    });
  }
});

router.get("/:id", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const response = await callRpc("get_customer_by_id", {
      p_id: id,
    });

    if (!response.ok) {
      return res.status(500).json({
        success: false,
        message: "Erro ao buscar cliente",
        details: response.data,
      });
    }

    const customer = Array.isArray(response.data) ? response.data[0] : null;

    if (!customer) {
      return res.status(404).json({
        success: false,
        message: "Cliente não encontrado",
      });
    }

    return res.status(200).json({
      success: true,
      customer: {
        id: customer.id,
        name: customer.full_name,
        email: customer.email,
        phone: customer.phone || "",
        city: customer.city || "",
        state: customer.state || "",
        origin: customer.origin || "Site",
        status: customer.status || "lead",
        notes: customer.notes || "",
        totalOrders: Number(customer.total_orders || 0),
        totalSpent: Number(customer.total_spent || 0),
        lastPurchase: formatDate(customer.last_purchase_at),
      },
    });
  } catch (error) {
    console.error("ERRO AO BUSCAR CLIENTE:", error);

    return res.status(500).json({
      success: false,
      message: "Erro interno ao buscar cliente",
    });
  }
});

export default router;