function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

export function getMasterAdminEmails() {
  const raw =
    process.env.MASTER_ADMIN_EMAIL ||
    process.env.MASTER_ADMIN_EMAILS ||
    process.env.ADMIN_MASTER_EMAIL ||
    "";

  return String(raw || "")
    .split(",")
    .map(normalizeEmail)
    .filter(Boolean);
}

export function isMasterAdmin(admin = {}) {
  const adminEmail = normalizeEmail(admin.email);
  const masterEmails = getMasterAdminEmails();

  if (masterEmails.length > 0) {
    return masterEmails.includes(adminEmail);
  }

  const role = String(admin.role || "").trim().toLowerCase();
  return ["master", "owner", "super_admin", "superadmin"].includes(role);
}

export function requireMasterAdmin(req, res, next) {
  if (!req.admin) {
    return res.status(401).json({
      success: false,
      message: "Administrador não autenticado.",
    });
  }

  if (!isMasterAdmin(req.admin)) {
    return res.status(403).json({
      success: false,
      message: "Acesso exclusivo do administrador master.",
    });
  }

  return next();
}
