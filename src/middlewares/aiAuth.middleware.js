export function requireAiAccess(req, res, next) {
  if (!req.admin || !req.admin.id) {
    return res.status(401).json({
      success: false,
      message: "Administrador não autenticado.",
    });
  }

  if (!String(req.admin.role || "").trim()) {
    return res.status(403).json({
      success: false,
      message: "Administrador sem função válida.",
    });
  }

  return next();
}
