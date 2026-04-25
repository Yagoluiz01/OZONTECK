import jwt from "jsonwebtoken";

import { env } from "../config/env.js";

export function requireAdminAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        message: "Token não enviado.",
      });
    }

    const token = authHeader.split(" ")[1];

    if (!token) {
      return res.status(401).json({
        success: false,
        message: "Token não enviado.",
      });
    }

    const decoded = jwt.verify(token, env.jwtSecret);

    if (!decoded?.admin_id || !decoded?.email || !decoded?.role) {
      return res.status(401).json({
        success: false,
        message: "Token inválido.",
      });
    }

    req.admin = {
      id: decoded.admin_id,
      userId: decoded.sub,
      email: decoded.email,
      role: decoded.role,
    };

    return next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: "Token inválido ou expirado.",
    });
  }
}

export function requireAdminRole(req, res, next) {
  if (!req.admin) {
    return res.status(401).json({
      success: false,
      message: "Administrador não autenticado.",
    });
  }

  return next();
}