import * as bannersService from "../services/banners.service.js";
import { supabaseAdmin } from "../config/supabase.js";

const ACTIVE_BANNERS_CACHE_TTL_MS = 60_000;
let activeBannersCache = { banners: null, expiresAt: 0 };
let activeBannersRequest = null;

function invalidateActiveBannersCache() {
  activeBannersCache = { banners: null, expiresAt: 0 };
}

async function getCachedActiveBanners() {
  const now = Date.now();
  if (activeBannersCache.banners && activeBannersCache.expiresAt > now) {
    return activeBannersCache.banners;
  }

  // Reaproveita a mesma Promise quando várias visitas chegam juntas.
  if (!activeBannersRequest) {
    activeBannersRequest = bannersService.getActiveBanners()
      .then((banners) => {
        activeBannersCache = {
          banners,
          expiresAt: Date.now() + ACTIVE_BANNERS_CACHE_TTL_MS,
        };
        return banners;
      })
      .finally(() => {
        activeBannersRequest = null;
      });
  }

  return activeBannersRequest;
}

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
    const banners = await getCachedActiveBanners();
    res.set("Cache-Control", "public, max-age=60, s-maxage=60");
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
      desktop_image,
      desktop_video,
      mobile_image,
      mobile_video,
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
      desktop_image: desktop_image || "",
      desktop_video: desktop_video || "",
      mobile_image: mobile_image || "",
      mobile_video: mobile_video || "",
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

    invalidateActiveBannersCache();
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

    invalidateActiveBannersCache();
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

    invalidateActiveBannersCache();
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

    invalidateActiveBannersCache();
    return res.status(200).json({ success: true, banner: result.banner });
  } catch (error) {
    console.error("ERRO DUPLICAR BANNER:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Erro interno ao duplicar banner",
    });
  }
}

export async function trackBannerEvent(req, res) {
  try {
    const {
      banner_id,
      event_type,
      click_type,
      view_duration_ms,
      session_id,
      user_agent,
      screen_width,
      screen_height,
      viewport_width,
      viewport_height,
      device_type,
      browser,
      os,
      timestamp,
    } = req.body || {};

    const validEventTypes = new Set(["impression", "click", "view_duration"]);
    const validClickTypes = new Set(["cta", "swipe", "dot"]);
    const validDeviceTypes = new Set(["mobile", "tablet", "desktop"]);

    if (!banner_id || !event_type || !session_id) {
      return res.status(400).json({
        success: false,
        message: "banner_id, event_type e session_id são obrigatórios",
      });
    }

    if (!validEventTypes.has(event_type)) {
      return res.status(400).json({
        success: false,
        message: "event_type inválido",
      });
    }

    if (event_type === "click" && click_type && !validClickTypes.has(click_type)) {
      return res.status(400).json({
        success: false,
        message: "click_type inválido",
      });
    }

    const toIntOrNull = (value, max = 100000) => {
      const number = Number(value);
      if (!Number.isFinite(number)) return null;
      return Math.max(0, Math.min(Math.trunc(number), max));
    };

    const eventTimestamp = new Date(timestamp || Date.now());
    const safeTimestamp = Number.isNaN(eventTimestamp.getTime())
      ? new Date().toISOString()
      : eventTimestamp.toISOString();

    const forwardedFor = String(req.headers["x-forwarded-for"] || "")
      .split(",")[0]
      .trim();

    const trackingPayload = {
      banner_id: String(banner_id),
      event_type,
      click_type: event_type === "click" ? (click_type || "cta") : null,
      view_duration_ms:
        event_type === "view_duration"
          ? toIntOrNull(view_duration_ms, 86_400_000)
          : null,
      session_id: String(session_id).slice(0, 255),
      timestamp: safeTimestamp,
      user_agent: String(user_agent || req.headers["user-agent"] || "").slice(0, 2000) || null,
      screen_width: toIntOrNull(screen_width),
      screen_height: toIntOrNull(screen_height),
      viewport_width: toIntOrNull(viewport_width),
      viewport_height: toIntOrNull(viewport_height),
      device_type: validDeviceTypes.has(device_type) ? device_type : null,
      browser: browser ? String(browser).slice(0, 50) : null,
      os: os ? String(os).slice(0, 50) : null,
      ip_address: (forwardedFor || req.ip || "").slice(0, 45) || null,
    };

    const { error: trackingError } = await supabaseAdmin
      .from("banner_tracking")
      .insert(trackingPayload);

    if (trackingError) {
      console.warn("Erro ao registrar evento de banner:", trackingError.message);
      return res.status(500).json({
        success: false,
        message: "Não foi possível registrar a métrica do banner",
      });
    }

    if (event_type === "impression") {
      const { error } = await supabaseAdmin.rpc("increment_banner_views", {
        p_banner_id: banner_id,
      });
      if (error) console.warn("Erro ao incrementar views do banner:", error.message);
    } else if (event_type === "click") {
      const { error } = await supabaseAdmin.rpc("increment_banner_clicks", {
        p_banner_id: banner_id,
      });
      if (error) console.warn("Erro ao incrementar clicks do banner:", error.message);
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    console.warn("Erro ao registrar tracking de banner:", error);
    return res.status(500).json({
      success: false,
      message: "Erro ao registrar métrica do banner",
    });
  }
}

export async function trackBannerClick(req, res) {
  try {
    const { id } = req.params;

    const { error } = await supabaseAdmin.rpc("increment_banner_clicks", {
      p_banner_id: id,
    });

    if (error) {
      console.warn("Erro ao trackar clique:", error.message);
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    console.warn("Erro ao trackar clique:", error);
    return res.status(200).json({ success: true });
  }
}

export async function trackBannerView(req, res) {
  try {
    const { id } = req.params;

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
    invalidateActiveBannersCache();
    return res.status(200).json({ success: true, message: result.message });
  } catch (error) {
    console.error("ERRO REORDENAR BANNERS:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Erro interno ao reordenar banners",
    });
  }
}
