import {
  getAdminById,
  getAdminPermissions,
  getCatalogKeysMap,
  listPermissionCatalog,
  replaceAdminPermissions,
  setAdminMaster,
} from "../../repositories/permission.repository.js";
import {
  getCachedAdminPermissionSet,
  invalidateAdminPermissionCache,
  setCachedAdminPermissionSet,
} from "./permission.cache.js";

const CACHE_TTL_MS = 60_000;

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function getMasterEmails() {
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

function isLegacyMasterByEmail(admin = {}) {
  const masterEmails = getMasterEmails();
  if (!masterEmails.length) return false;
  return masterEmails.includes(normalizeEmail(admin.email));
}

function isLegacyMasterByRole(admin = {}) {
  const role = String(admin.role || "").trim().toLowerCase();
  return ["master", "owner", "super_admin", "superadmin"].includes(role);
}

export function isMasterAdmin(admin = {}) {
  if (admin?.is_master === true) return true;
  if (isLegacyMasterByEmail(admin)) return true;
  if (isLegacyMasterByRole(admin)) return true;
  return false;
}

export async function getEffectiveAdminPermissions(admin = {}) {
  const adminId = String(admin?.id || "").trim();
  if (!adminId) return new Set();

  if (isMasterAdmin(admin)) {
    return new Set(["*"]);
  }

  const cached = getCachedAdminPermissionSet(adminId);
  if (cached instanceof Set) return cached;

  const permissionKeys = await getAdminPermissions(adminId);
  const permissionSet = new Set(permissionKeys);

  setCachedAdminPermissionSet(adminId, permissionSet, CACHE_TTL_MS);
  return permissionSet;
}

export async function hasPermission(admin = {}, permissionKey) {
  const key = String(permissionKey || "").trim();
  if (!key) return false;

  if (isMasterAdmin(admin)) return true;

  const permissions = await getEffectiveAdminPermissions(admin);
  if (permissions.has("*")) return true;
  return permissions.has(key);
}

export async function getPermissionCatalogGrouped() {
  const catalog = await listPermissionCatalog();
  const grouped = {};

  for (const item of catalog) {
    const moduleName = String(item.module || "general").trim() || "general";
    if (!grouped[moduleName]) grouped[moduleName] = [];
    grouped[moduleName].push(item);
  }

  return { catalog, grouped };
}

export async function assignAdminPermissions({ adminId, permissions = [], isMaster = false }) {
  const admin = await getAdminById(adminId);
  if (!admin) {
    const error = new Error("Administrador não encontrado.");
    error.statusCode = 404;
    throw error;
  }

  const nextIsMaster = Boolean(isMaster);
  const updatedAdmin = await setAdminMaster(adminId, nextIsMaster);

  if (nextIsMaster) {
    await replaceAdminPermissions(adminId, []);
    invalidateAdminPermissionCache(adminId);

    return {
      admin: updatedAdmin,
      permissions: [],
      is_master: true,
    };
  }

  const validKeys = await getCatalogKeysMap();
  const normalizedPermissions = [...new Set(
    (permissions || []).map((v) => String(v || "").trim()).filter(Boolean)
  )];

  const invalid = normalizedPermissions.filter((key) => !validKeys.has(key));
  if (invalid.length > 0) {
    const error = new Error(`Permissões inválidas: ${invalid.join(", ")}`);
    error.statusCode = 400;
    throw error;
  }

  const persisted = await replaceAdminPermissions(adminId, normalizedPermissions);
  invalidateAdminPermissionCache(adminId);

  return {
    admin: updatedAdmin,
    permissions: persisted,
    is_master: false,
  };
}

export async function setAdminMasterFlag({ adminId, isMaster }) {
  const admin = await getAdminById(adminId);
  if (!admin) {
    const error = new Error("Administrador não encontrado.");
    error.statusCode = 404;
    throw error;
  }

  const updated = await setAdminMaster(adminId, Boolean(isMaster));

  if (Boolean(isMaster)) {
    await replaceAdminPermissions(adminId, []);
  }

  invalidateAdminPermissionCache(adminId);

  return updated;
}
