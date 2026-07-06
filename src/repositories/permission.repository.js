import { supabaseAdmin } from "../config/supabase.js";

export async function listPermissionCatalog() {
  const { data, error } = await supabaseAdmin
    .from("permissions_catalog")
    .select("key,label,module,description,is_active")
    .eq("is_active", true)
    .order("module", { ascending: true })
    .order("key", { ascending: true });

  if (error) {
    throw new Error("Erro ao listar catálogo de permissões.");
  }

  return Array.isArray(data) ? data : [];
}

export async function getAdminPermissions(adminId) {
  const { data, error } = await supabaseAdmin
    .from("admin_permissions")
    .select("permission_key")
    .eq("admin_id", adminId);

  if (error) {
    throw new Error("Erro ao consultar permissões do administrador.");
  }

  return (data || []).map((row) => row.permission_key).filter(Boolean);
}

export async function replaceAdminPermissions(adminId, permissionKeys = []) {
  const uniqueKeys = [...new Set((permissionKeys || []).map((v) => String(v || "").trim()).filter(Boolean))];

  const { error: deleteError } = await supabaseAdmin
    .from("admin_permissions")
    .delete()
    .eq("admin_id", adminId);

  if (deleteError) {
    throw new Error("Erro ao limpar permissões atuais do administrador.");
  }

  if (uniqueKeys.length === 0) {
    return [];
  }

  const payload = uniqueKeys.map((permissionKey) => ({
    admin_id: adminId,
    permission_key: permissionKey,
  }));

  const { error: insertError } = await supabaseAdmin
    .from("admin_permissions")
    .insert(payload);

  if (insertError) {
    throw new Error("Erro ao salvar permissões do administrador.");
  }

  return uniqueKeys;
}

export async function setAdminMaster(adminId, isMaster) {
  const { data, error } = await supabaseAdmin
    .from("admins")
    .update({ is_master: Boolean(isMaster) })
    .eq("id", adminId)
    .select("id,full_name,email,role,is_active,is_master")
    .single();

  if (error || !data) {
    throw new Error("Erro ao atualizar flag master do administrador.");
  }

  return data;
}

export async function getAdminById(adminId) {
  const { data, error } = await supabaseAdmin
    .from("admins")
    .select("id,full_name,email,role,is_active,is_master")
    .eq("id", adminId)
    .maybeSingle();

  if (error) {
    throw new Error("Erro ao consultar administrador.");
  }

  return data || null;
}

export async function getCatalogKeysMap() {
  const catalog = await listPermissionCatalog();
  return new Set(catalog.map((item) => item.key));
}
