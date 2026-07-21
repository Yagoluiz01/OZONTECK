import { supabaseAdmin } from "../config/supabase.js";
import sharp from "sharp";

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

export async function createCategory({ name, slug, icon, icon_url, description, parent_id, sort_order, is_active }) {
  const { data, error } = await supabaseAdmin.rpc("create_category", {
    p_name: name,
    p_slug: slug,
    p_icon: icon || "📦",
    p_icon_url: icon_url || null,
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

export async function updateCategory(id, { name, slug, icon, icon_url, description, parent_id, sort_order, is_active }) {
  const params = {
    p_id: id,
    p_name: name || null,
    p_slug: slug || null,
    p_icon: icon || null,
    p_icon_url: icon_url || null,
    p_description: description !== undefined ? description : null,
    p_parent_id: parent_id !== undefined ? parent_id : null,
    p_sort_order: sort_order !== undefined ? sort_order : null,
    p_is_active: is_active !== undefined ? is_active : null,
  };

  const { data, error } = await supabaseAdmin.rpc("update_category", params);

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

export async function getCategoryProducts(categoryId) {
  const { data, error } = await supabaseAdmin
    .from("products")
    .select("id, name, sku, price, status, image_url, stock_quantity")
    .eq("category_id", categoryId)
    .order("name", { ascending: true });

  if (error) {
    console.error("ERRO AO BUSCAR PRODUTOS DA CATEGORIA:", error);
    throw new Error("Erro ao buscar produtos da categoria");
  }

  return data || [];
}

export async function uploadCategoryIcon(categoryId, file) {
  if (!file) throw new Error("Arquivo não enviado");

  const rawBuffer = file.buffer || file;

  let optimizedBuffer = rawBuffer;
  try {
    optimizedBuffer = await sharp(rawBuffer)
      .resize(120, 120, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 85 })
      .toBuffer();
  } catch (e) {
    console.warn("Falha ao otimizar imagem, usando original:", e);
  }

  const fileName = `category-${categoryId}-${Date.now()}.webp`;
  const filePath = `icons/${fileName}`;
  const contentType = "image/webp";

  const { error: uploadError, data: uploadData, status } = await supabaseAdmin.storage
    .from("category-icons")
    .upload(filePath, optimizedBuffer, {
      cacheControl: "3600",
      upsert: true,
      contentType,
    });

  if (uploadError || status > 400) {
    const msg = uploadError?.message || `HTTP ${status}`;
    console.error("ERRO UPLOAD ÍCONE DETALHES:", uploadError);
    throw new Error(`Erro ao fazer upload: ${msg}`);
  }

  const { data: urlData } = supabaseAdmin.storage
    .from("category-icons")
    .getPublicUrl(filePath);

  const iconUrl = urlData?.publicUrl || null;

  if (iconUrl) {
    const { error: updateError } = await supabaseAdmin.rpc("update_category", {
      p_id: categoryId,
      p_name: null,
      p_slug: null,
      p_icon: null,
      p_icon_url: iconUrl,
      p_description: null,
      p_parent_id: null,
      p_sort_order: null,
      p_is_active: null,
    });

    if (updateError) {
      console.error("ERRO AO SALVAR ICON_URL:", updateError);
      throw new Error("Erro ao salvar URL do ícone");
    }
  }

  return { icon_url: iconUrl };
}

export async function updateCategoryProducts(categoryId, productIds) {
  const { data: currentProducts, error: fetchError } = await supabaseAdmin
    .from("products")
    .select("id")
    .eq("category_id", categoryId);

  if (fetchError) {
    console.error("ERRO AO BUSCAR PRODUTOS DA CATEGORIA:", fetchError);
    throw new Error("Erro ao buscar produtos da categoria");
  }

  const currentIds = (currentProducts || []).map((p) => p.id);
  const toRemove = currentIds.filter((id) => !productIds.includes(id));
  if (toRemove.length > 0) {
    const { error: removeError } = await supabaseAdmin
      .from("products")
      .update({ category_id: null })
      .in("id", toRemove);

    if (removeError) {
      console.error("ERRO AO REMOVER PRODUTOS DA CATEGORIA:", removeError);
      throw new Error("Erro ao desvincular produtos da categoria");
    }
  }

  const toAdd = productIds.filter((id) => !currentIds.includes(id));
  if (toAdd.length > 0) {
    const { error: addError } = await supabaseAdmin
      .from("products")
      .update({ category_id: categoryId })
      .in("id", toAdd);

    if (addError) {
      console.error("ERRO AO VINCULAR PRODUTOS:", addError);
      throw new Error("Erro ao vincular produtos à categoria");
    }
  }

  return { message: "Produtos atualizados com sucesso" };
}