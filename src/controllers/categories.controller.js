import * as categoriesService from "../services/categories.service.js";

export async function listAllCategories(req, res) {
  try {
    const categories = await categoriesService.getAllCategories();
    return res.status(200).json({ success: true, categories });
  } catch (error) {
    console.error("ERRO LISTAR CATEGORIAS:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Erro interno ao listar categorias",
    });
  }
}

export async function listActiveCategories(req, res) {
  try {
    const categories = await categoriesService.getActiveCategories();
    return res.status(200).json({ success: true, categories });
  } catch (error) {
    console.error("ERRO LISTAR CATEGORIAS ATIVAS:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Erro interno ao listar categorias ativas",
    });
  }
}

export async function getCategory(req, res) {
  try {
    const { id } = req.params;
    const category = await categoriesService.getCategoryById(id);

    if (!category) {
      return res.status(404).json({
        success: false,
        message: "Categoria não encontrada",
      });
    }

    return res.status(200).json({ success: true, category });
  } catch (error) {
    console.error("ERRO BUSCAR CATEGORIA:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Erro interno ao buscar categoria",
    });
  }
}

export async function createCategory(req, res) {
  try {
    const { name, slug, icon, description, parent_id, sort_order, is_active } = req.body;

    if (!name || !slug) {
      return res.status(400).json({
        success: false,
        message: "Nome e slug são obrigatórios",
      });
    }

    const category = await categoriesService.createCategory({
      name: name.trim(),
      slug: slug.trim().toLowerCase(),
      icon,
      description,
      parent_id,
      sort_order,
      is_active,
    });

    return res.status(201).json({ success: true, category });
  } catch (error) {
    console.error("ERRO CRIAR CATEGORIA:", error);

    if (error.message?.includes("duplicate") || error.message?.includes("já existe")) {
      return res.status(409).json({
        success: false,
        message: error.message || "Já existe uma categoria com este nome",
      });
    }

    return res.status(500).json({
      success: false,
      message: error.message || "Erro interno ao criar categoria",
    });
  }
}

export async function updateCategory(req, res) {
  try {
    const { id } = req.params;
    const { name, slug, icon, icon_url, description, parent_id, sort_order, is_active } = req.body;

    const category = await categoriesService.updateCategory(id, {
      name: name?.trim(),
      slug: slug?.trim().toLowerCase(),
      icon,
      icon_url,
      description,
      parent_id,
      sort_order,
      is_active,
    });

    return res.status(200).json({ success: true, category });
  } catch (error) {
    console.error("ERRO ATUALIZAR CATEGORIA:", error);

    if (error.message?.includes("duplicate") || error.message?.includes("já existe")) {
      return res.status(409).json({
        success: false,
        message: error.message || "Já existe uma categoria com este nome",
      });
    }

    return res.status(500).json({
      success: false,
      message: error.message || "Erro interno ao atualizar categoria",
    });
  }
}

export async function deleteCategory(req, res) {
  try {
    const { id } = req.params;
    const { move_to_category_id } = req.body;

    const result = await categoriesService.deleteCategory(id, move_to_category_id || null);

    if (!result.success && result.requires_move) {
      return res.status(400).json({
        success: false,
        message: result.message,
        product_count: result.product_count,
        requires_move: true,
      });
    }

    return res.status(200).json({ success: true, message: result.message });
  } catch (error) {
    console.error("ERRO EXCLUIR CATEGORIA:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Erro interno ao excluir categoria",
    });
  }
}

export async function reorderCategories(req, res) {
  try {
    const { orders } = req.body;

    if (!Array.isArray(orders) || orders.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Lista de ordenação inválida",
      });
    }

    const result = await categoriesService.reorderCategories(orders);
    return res.status(200).json({ success: true, message: result.message });
  } catch (error) {
    console.error("ERRO REORDENAR CATEGORIAS:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Erro interno ao reordenar categorias",
    });
  }
}

export async function uploadCategoryIconController(req, res) {
  try {
    const { id } = req.params;

    console.log("UPLOAD ICON REQUEST:", {
      id,
      hasFile: !!req.file,
      fileInfo: req.file
        ? {
            originalname: req.file.originalname,
            mimetype: req.file.mimetype,
            size: req.file.size,
          }
        : null,
    });

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "Nenhum arquivo enviado. Certifique-se de enviar no campo 'icon'.",
      });
    }

    const result = await categoriesService.uploadCategoryIcon(id, req.file);
    return res.status(200).json({ success: true, icon_url: result.icon_url });
  } catch (error) {
    console.error("ERRO UPLOAD ÍCONE CATEGORIA:", {
      message: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      success: false,
      message: error.message || "Erro interno ao fazer upload do ícone",
    });
  }
}

export async function getCategoryProducts(req, res) {
  try {
    const { id } = req.params;
    const products = await categoriesService.getCategoryProducts(id);
    return res.status(200).json({ success: true, products });
  } catch (error) {
    console.error("ERRO LISTAR PRODUTOS DA CATEGORIA:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Erro interno ao listar produtos da categoria",
    });
  }
}

export async function updateCategoryProducts(req, res) {
  try {
    const { id } = req.params;
    const { product_ids } = req.body;

    if (!Array.isArray(product_ids)) {
      return res.status(400).json({
        success: false,
        message: "Lista de produtos inválida",
      });
    }

    const result = await categoriesService.updateCategoryProducts(id, product_ids);
    return res.status(200).json({ success: true, message: result.message });
  } catch (error) {
    console.error("ERRO ATUALIZAR PRODUTOS DA CATEGORIA:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Erro interno ao atualizar produtos da categoria",
    });
  }
}
