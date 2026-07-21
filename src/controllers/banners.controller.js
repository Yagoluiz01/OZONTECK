import * as bannersService from "../services/banners.service.js";
import { supabaseAdmin } from "../config/supabase.js";

export async function listAllBanners(req, res) {
  try {
    const banners = await bannersService.getAllBanners();
    return res.status(200).json({ success: true, banners });
  } catch (error) {
    console.error("ERRO LISTAR BANNERS:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Erro interno ao listar banners",
    });
  }
}

export async function listActiveBanners(req, res) {
  try {
    const banners = await bannersService.getActiveBanners();
    return res.status(200).json({ success: true, banners });
  } catch (error) {
    console.error("ERRO LISTAR BANNERS ATIVOS:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Erro interno ao listar banners ativos",
    });
  }
}

export async function getBannerStats(req, res) {
  try {
    const { id } = req.params;
    const { period = '30d' } = req.query;
    
    const stats = await bannersService.getBannerStats(id, period);
    return res.status(200).json({ 
      success: true, 
      data: { 
        banner_id: id, 
        period, 
        stats 
      } 
    });
  } catch (error) {
    console.error("ERRO STATS BANNER:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Erro ao carregar estatísticas",
    });
  }
}

export async function getBanner(req, res) {
  try {
    const { id } = req.params;
    const banner = await bannersService.getBannerById(id);

    return res.status(200).json({ success: true, banner });
  } catch (error) {
    console.error("ERRO BUSCAR BANNER:", error);
    
    if (error.message === "Banner não encontrado") {
      return res.status(404).json({
        success: false,
        message: "Banner não encontrado",
      });
    }

    return res.status(500).json({
      success: false,
      message: error.message || "Erro interno ao buscar banner",
    });
  }
}

export async function createBanner(req, res) {
  try {
    const {
      title,
      subtitle,
      description,
      button_text,
      link,
      content_position,
      // Novos campos responsivos
      desktop_image,
      desktop_video,
      mobile_image,
      mobile_video,
      // Campos extras
      alt_text,
      page_target,
      sort_order,
      display_duration,
      autoplay,
      loop,
      show_indicators,
      show_arrows,
      is_active,
      is_primary,
      start_date,
      end_date,
      status,
    } = req.body;

    if (!title) {
      return res.status(400).json({
        success: false,
        message: "Título é obrigatório",
      });
    }

    // Validar tamanho dos arquivos (URLs são strings, mas verificar se não estão vazias)
    const validationErrors = [];
    
    if (desktop_image && typeof desktop_image === 'string' && desktop_image.startsWith('blob:')) {
      validationErrors.push("desktop_image ainda não foi processada");
    }
    if (mobile_image && typeof mobile_image === 'string' && mobile_image.startsWith('blob:')) {
      validationErrors.push("mobile_image ainda não foi processada");
    }

    if (validationErrors.length > 0) {
      return res.status(400).json({
        success: false,
        message: validationErrors.join(", "),
      });
    }

    const banner = await bannersService.createBanner({
      title: title.trim(),
      subtitle: subtitle?.trim() || "",
      description: description?.trim() || "",
      button_text: button_text?.trim() || "",
      link: link?.trim() || "",
      content_position: content_position || "left",
      // Novos campos responsivos
      desktop_image: desktop_image || "",
      desktop_video: desktop_video || "",
      mobile_image: mobile_image || "",
      mobile_video: mobile_video || "",
      // Campos extras
      alt_text: alt_text?.trim() || "",
      page_target: page_target || "home",
      sort_order: sort_order || 0,
      display_duration: display_duration || 5000,
      autoplay: autoplay !== false,
      loop: loop !== false,
      show_indicators: show_indicators !== false,
      show_arrows: show_arrows !== false,
      is_active: is_active !== false,
      is_primary: is_primary === true,
      start_date: start_date || null,
      end_date: end_date || null,
      status: status || "published",
    });

    return res.status(201).json({ success: true, banner });
  } catch (error) {
    console.error("ERRO CRIAR BANNER:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Erro interno ao criar banner",
    });
  }
}

export async function updateBanner(req, res) {
  try {
    const { id } = req.params;
    const payload = req.body;

    const banner = await bannersService.updateBanner(id, payload);

    return res.status(200).json({ success: true, banner });
  } catch (error) {
    console.error("ERRO ATUALIZAR BANNER:", error);

    if (error.message === "Banner não encontrado") {
      return res.status(404).json({
        success: false,
        message: "Banner não encontrado",
      });
    }

    return res.status(500).json({
      success: false,
      message: error.message || "Erro interno ao atualizar banner",
    });
  }
}

export async function deleteBanner(req, res) {
  try {
    const { id } = req.params;
    const result = await bannersService.deleteBanner(id);

    if (!result.success) {
      return res.status(404).json({
        success: false,
        message: result.message,
      });
    }

    return res.status(200).json({ success: true, message: result.message });
  } catch (error) {
    console.error("ERRO EXCLUIR BANNER:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Erro interno ao excluir banner",
    });
  }
}

export async function duplicateBanner(req, res) {
  try {
    const { id } = req.params;
    const result = await bannersService.duplicateBanner(id);

    if (!result.success) {
      return res.status(404).json({
        success: false,
        message: result.message,
      });
    }

    return res.status(200).json({ success: true, banner: result.banner });
  } catch (error) {
    console.error("ERRO DUPLICAR BANNER:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Erro interno ao duplicar banner",
    });
  }
}

export async function trackBannerClick(req, res) {
  try {
    const { id } = req.params;
    
    // Incrementar contador de cliques no banner
    const { error } = await supabaseAdmin.rpc("increment_banner_clicks", {
      p_banner_id: id,
    });

    if (error) {
      // Não lançar erro - tracking é opcional
      console.warn("Erro ao trackar clique:", error.message);
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    console.warn("Erro ao trackar clique:", error);
    return res.status(200).json({ success: true }); // Sempre retornar sucesso
  }
}

export async function trackBannerView(req, res) {
  try {
    const { id } = req.params;
    
    // Incrementar contador de visualizações no banner
    const { error } = await supabaseAdmin.rpc("increment_banner_views", {
      p_banner_id: id,
    });

    if (error) {
      console.warn("Erro ao trackar visualização:", error.message);
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    console.warn("Erro ao trackar visualização:", error);
    return res.status(200).json({ success: true });
  }
}

export async function reorderBanners(req, res) {
  try {
    const { orders } = req.body;

    if (!Array.isArray(orders) || orders.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Lista de ordenação inválida",
      });
    }

    const result = await bannersService.reorderBanners(orders);
    return res.status(200).json({ success: true, message: result.message });
  } catch (error) {
    console.error("ERRO REORDENAR BANNERS:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Erro interno ao reordenar banners",
    });
  }
}
