import { supabaseAdmin } from "../config/supabase.js";

export async function getAllCategories() {
  const { data, error } = await supabaseAdmin.rpc("get_all_categories");

  if (error) {
    console.error("ERRO AO BUSCAR CATEGORIAS:", error);
    throw new Error("Erro ao buscar categorias");
  }

  return data || [];
}

export async function getActiveCategories() {
  const { data, error } = await supabaseAdmin.rpc("get_active_categories");

  if (error) {
    console.error("ERRO AO BUSCAR CATEGORIAS ATIVAS:", error);
    throw new Error("Erro ao buscar categorias ativas");
  }

  return data || [];
}

export async function createCategory({ name, slug, icon, description, parent_id, sort_order, is_active }) {
  const { data, error } = await supabaseAdmin.rpc("create_category", {
    p_name: name,
    p_slug: slug,
    p_icon: icon || "📦",
    p_description: description || "",
    p_parent_id: parent_id || null,
    p_sort_order: sort_order || 0,
    p_is_active: is_active !== undefined ? is_active : true,
  });

  if (error) {
    console.error("ERRO AO CRIAR CATEGORIA:", error);
    throw new Error(error.message || "Erro ao criar categoria");
  }

  return data;
}

export async function updateCategory(id, { name, slug, icon, description, parent_id, sort_order, is_active }) {
  const { data, error } = await supabaseAdmin.rpc("update_category", {
    p_id: id,
    p_name: name || null,
    p_slug: slug || null,
    p_icon: icon || null,
    p_description: description !== undefined ? description : null,
    p_parent_id: parent_id !== undefined ? parent_id : null,
    p_sort_order: sort_order !== undefined ? sort_order : null,
    p_is_active: is_active !== undefined ? is_active : null,
  });

  if (error) {
    console.error("ERRO AO ATUALIZAR CATEGORIA:", error);
    throw new Error(error.message || "Erro ao atualizar categoria");
  }

  return data;
}

export async function deleteCategory(id, moveToCategoryId = null) {
  const { data, error } = await supabaseAdmin.rpc("delete_category", {
    p_id: id,
    p_move_to_category_id: moveToCategoryId,
  });

  if (error) {
    console.error("ERRO AO EXCLUIR CATEGORIA:", error);
    throw new Error(error.message || "Erro ao excluir categoria");
  }

  return data;
}

export async function reorderCategories(orders) {
  const { data, error } = await supabaseAdmin.rpc("reorder_categories", {
    p_orders: JSON.stringify(orders),
  });

  if (error) {
    console.error("ERRO AO REORDENAR CATEGORIAS:", error);
    throw new Error(error.message || "Erro ao reordenar categorias");
  }

  return data;
}

export async function getCategoryById(id) {
  const { data, error } = await supabaseAdmin
    .from("categories")
    .select("*")
    .eq("id", id)
    .single();

  if (error) {
    console.error("ERRO AO BUSCAR CATEGORIA:", error);
    throw new Error("Erro ao buscar categoria");
  }

  return data;
}