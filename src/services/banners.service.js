import { supabaseAdmin } from "../config/supabase.js";
import {
  normalizeTimeoutMs,
  withTimeout,
} from "../utils/upstreamTimeout.js";

const BANNER_TRACKING_RPC = "record_banner_tracking_event";
const PUBLIC_ORIGIN_TIMEOUT_MS = normalizeTimeoutMs(
  process.env.PUBLIC_ORIGIN_TIMEOUT_MS,
  8_000,
);

function isMissingBannerTrackingRpc(error) {
  const code = String(error?.code || "").toUpperCase();
  const message = String(error?.message || "").toLowerCase();

  return (
    code === "PGRST202" ||
    code === "42883" ||
    (
      message.includes(BANNER_TRACKING_RPC) &&
      (message.includes("could not find the function") || message.includes("does not exist"))
    )
  );
}

// Usa uma única transação no banco. Enquanto a migration ainda não tiver sido
// aplicada, mantém o comportamento antigo para permitir uma publicação segura.
export async function recordBannerTrackingEvent(payload, client = supabaseAdmin) {
  const { error: atomicError } = await client.rpc(BANNER_TRACKING_RPC, {
    p_banner_id: payload.banner_id,
    p_event_type: payload.event_type,
    p_click_type: payload.click_type,
    p_view_duration_ms: payload.view_duration_ms,
    p_session_id: payload.session_id,
    p_timestamp: payload.timestamp,
    p_user_agent: payload.user_agent,
    p_screen_width: payload.screen_width,
    p_screen_height: payload.screen_height,
    p_viewport_width: payload.viewport_width,
    p_viewport_height: payload.viewport_height,
    p_device_type: payload.device_type,
    p_browser: payload.browser,
    p_os: payload.os,
    p_ip_address: payload.ip_address,
  });

  if (!atomicError) {
    return { mode: "atomic" };
  }

  // Não repete a gravação em erros de rede ou execução, pois a primeira
  // tentativa pode ter sido concluída no banco. O fallback é exclusivo para
  // quando a função nova ainda não existe.
  if (!isMissingBannerTrackingRpc(atomicError)) {
    throw atomicError;
  }

  const { error: trackingError } = await client
    .from("banner_tracking")
    .insert(payload);

  if (trackingError) {
    throw trackingError;
  }

  let counterError = null;
  if (payload.event_type === "impression") {
    ({ error: counterError } = await client.rpc("increment_banner_views", {
      p_banner_id: payload.banner_id,
    }));
  } else if (payload.event_type === "click") {
    ({ error: counterError } = await client.rpc("increment_banner_clicks", {
      p_banner_id: payload.banner_id,
    }));
  }

  return { mode: "fallback", counterError };
}

export async function getAllBanners() {
  const { data, error } = await supabaseAdmin.rpc("get_all_banners");

  if (error) {
    throw new Error(error.message || "Erro ao buscar banners");
  }

  return data || [];
}

export async function getActiveBanners() {
  const { data, error } = await withTimeout(
    supabaseAdmin.rpc("get_active_banners"),
    {
      timeoutMs: PUBLIC_ORIGIN_TIMEOUT_MS,
      label: "Banners públicos",
    },
  );

  if (error) {
    throw new Error(error.message || "Erro ao buscar banners ativos");
  }

  return data || [];
}

export async function getBannerById(id) {
  const { data, error } = await supabaseAdmin
    .from("banners")
    .select("id, title, subtitle, description, button_text, link, content_position, desktop_image, desktop_video, mobile_image, mobile_video, alt_text, page_target, is_active, sort_order, display_duration, autoplay, loop, show_indicators, show_arrows, is_primary, start_date, end_date, status, views_count, clicks_count, current_version, created_at, updated_at")
    .eq("id", id)
    .single();

  if (error) {
    if (error.code === "PGRST116") {
      throw new Error("Banner não encontrado");
    }
    throw new Error(error.message || "Erro ao buscar banner");
  }

  return data;
}

export async function createBanner(payload) {
  const { data, error } = await supabaseAdmin.rpc("create_banner", {
    p_title: payload.title,
    p_subtitle: payload.subtitle || "",
    p_description: payload.description || "",
    p_button_text: payload.button_text || "",
    p_link: payload.link || "",
    p_content_position: payload.content_position || "left",
    p_desktop_image: payload.desktop_image || "",
    p_mobile_image: payload.mobile_image || "",
    p_desktop_video: payload.desktop_video || "",
    p_mobile_video: payload.mobile_video || "",
    p_alt_text: payload.alt_text || "",
    p_page_target: payload.page_target || "home",
    p_sort_order: payload.sort_order || 0,
    p_display_duration: payload.display_duration || 5000,
    p_autoplay: payload.autoplay !== false,
    p_loop: payload.loop !== false,
    p_show_indicators: payload.show_indicators !== false,
    p_show_arrows: payload.show_arrows !== false,
    p_is_active: payload.is_active !== false,
    p_is_primary: payload.is_primary === true,
    p_start_date: payload.start_date || null,
    p_end_date: payload.end_date || null,
    p_status: payload.status || "published",
  });

  if (error) {
    throw new Error(error.message || "Erro ao criar banner");
  }

  return data;
}

export async function updateBanner(id, payload) {
  const { data, error } = await supabaseAdmin.rpc("update_banner", {
    p_id: id,
    p_title: payload.title,
    p_subtitle: payload.subtitle,
    p_description: payload.description,
    p_button_text: payload.button_text,
    p_link: payload.link,
    p_content_position: payload.content_position,
    p_desktop_image: payload.desktop_image,
    p_mobile_image: payload.mobile_image,
    p_desktop_video: payload.desktop_video,
    p_mobile_video: payload.mobile_video,
    p_alt_text: payload.alt_text,
    p_page_target: payload.page_target,
    p_sort_order: payload.sort_order,
    p_display_duration: payload.display_duration,
    p_autoplay: payload.autoplay,
    p_loop: payload.loop,
    p_show_indicators: payload.show_indicators,
    p_show_arrows: payload.show_arrows,
    p_is_active: payload.is_active,
    p_is_primary: payload.is_primary,
    p_start_date: payload.start_date,
    p_end_date: payload.end_date,
    p_status: payload.status,
  });

  if (error) {
    throw new Error(error.message || "Erro ao atualizar banner");
  }

  return data;
}

export async function deleteBanner(id) {
  const { data, error } = await supabaseAdmin.rpc("delete_banner", {
    p_id: id,
  });

  if (error) {
    throw new Error(error.message || "Erro ao excluir banner");
  }

  return data;
}

export async function duplicateBanner(id) {
  const { data, error } = await supabaseAdmin.rpc("duplicate_banner", {
    p_id: id,
  });

  if (error) {
    throw new Error(error.message || "Erro ao duplicar banner");
  }

  return data;
}

export async function getBannerStats(bannerId, period) {
  try {
    // Buscar dados de tracking da tabela banner_tracking
    const { data: trackingData, error: trackingError } = await supabaseAdmin
      .from('banner_tracking')
      .select('*')
      .eq('banner_id', bannerId);

    if (trackingError) throw trackingError;

    // Calcular período
    const now = new Date();
    let startDate = new Date();
    switch (period) {
      case '7d': startDate.setDate(now.getDate() - 7); break;
      case '30d': startDate.setDate(now.getDate() - 30); break;
      case '90d': startDate.setDate(now.getDate() - 90); break;
      case '365d': startDate.setDate(now.getDate() - 365); break;
      default: startDate.setDate(now.getDate() - 30);
    }

    // Filtrar por período. A tabela original usa `timestamp`; versões mais
    // novas podem expor `created_at`, por isso aceitamos ambos.
    const filteredData = (trackingData || []).filter((t) => {
      const rawDate = t.created_at || t.timestamp;
      if (!rawDate) return false;
      const eventDate = new Date(rawDate);
      return !Number.isNaN(eventDate.getTime()) && eventDate >= startDate;
    });

    // Calcular métricas
    const impressionEvents = filteredData.filter(t => t.event_type === 'impression');
    const clickEvents = filteredData.filter(t => t.event_type === 'click');
    const impressions = impressionEvents.length;
    const clicks = clickEvents.length;
    const clicksByType = aggregateBy(clickEvents, 'click_type');

    // Distribuição por dispositivo/navegador deve refletir visualizações,
    // não triplicar usuários por causa de click + view_duration.
    const devices = aggregateBy(impressionEvents, 'device_type');
    const browsers = aggregateBy(impressionEvents, 'browser');

    // Calcular tempo médio de visualização. O evento gravado pela loja é
    // `view_duration`; o nome antigo `view_time` nunca correspondia ao payload.
    const viewTimes = filteredData
      .filter(t => t.event_type === 'view_duration' && Number(t.view_duration_ms) > 0)
      .map(t => Number(t.view_duration_ms));
    const avgViewDurationMs = viewTimes.length > 0
      ? Math.round(viewTimes.reduce((a, b) => a + b, 0) / viewTimes.length)
      : 0;

    return {
      impressions,
      clicks,
      ctr: impressions > 0 ? ((clicks / impressions) * 100).toFixed(2) : 0,
      avg_view_duration_ms: avgViewDurationMs,
      clicks_by_type: clicksByType,
      devices,
      browsers,
    };
  } catch (error) {
    console.error('Erro ao buscar stats:', error);
    throw error;
  }
}

function aggregateBy(data, field) {
  const map = {};
  data.forEach(item => {
    const value = item[field] || 'unknown';
    const key = String(value).toLowerCase();
    map[key] = (map[key] || 0) + 1;
  });
  return Object.entries(map).map(([key, count]) => ({
    [field]: key,
    count,
  }));
}

export async function reorderBanners(orders) {
  const { data, error } = await supabaseAdmin.rpc("reorder_banners", {
    p_orders: orders,
  });

  if (error) {
    throw new Error(error.message || "Erro ao reordenar banners");
  }

  return data;
}

// Upload em lote de arquivos de banner
// Nota: O upload real é feito pelo frontend via banner-media-upload.service.js
// Esta função foi removida pois usava URL relativa em contexto Node.js
