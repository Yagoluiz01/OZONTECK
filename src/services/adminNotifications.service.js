import { supabaseAdmin } from "../config/supabase.js";

function normalizePriority(value) {
  const priority = String(value || "normal").toLowerCase();

  if (["low", "normal", "high", "critical"].includes(priority)) {
    return priority;
  }

  return "normal";
}

export async function createAdminNotification(payload = {}) {
  const title = String(payload.title || "").trim();
  const message = String(payload.message || "").trim();
  const type = String(payload.type || "system").trim() || "system";

  if (!title || !message) {
    return {
      success: false,
      notification: null,
      message: "Título e mensagem da notificação são obrigatórios.",
    };
  }

  const insertPayload = {
    type,
    title,
    message,
    entity_type: payload.entity_type || null,
    entity_id: payload.entity_id || null,
    priority: normalizePriority(payload.priority),
    is_read: false,
    metadata:
      payload.metadata && typeof payload.metadata === "object"
        ? payload.metadata
        : {},
  };

  const { data, error } = await supabaseAdmin
    .from("admin_notifications")
    .insert(insertPayload)
    .select("*")
    .single();

  if (error) {
    console.error("[ADMIN_NOTIFICATION_CREATE_ERROR]", error);
    throw new Error(error.message || "Erro ao criar notificação.");
  }

  return {
    success: true,
    notification: data,
    message: "Notificação criada com sucesso.",
  };
}

export async function listAdminNotifications(options = {}) {
  const limit = Math.min(Number(options.limit || 20), 50);
  const onlyUnread = Boolean(options.onlyUnread);

  let query = supabaseAdmin
    .from("admin_notifications")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (onlyUnread) {
    query = query.eq("is_read", false);
  }

  const { data, error } = await query;

  if (error) {
    console.error("[ADMIN_NOTIFICATION_LIST_ERROR]", error);
    throw new Error(error.message || "Erro ao buscar notificações.");
  }

  const { count, error: countError } = await supabaseAdmin
    .from("admin_notifications")
    .select("id", { count: "exact", head: true })
    .eq("is_read", false);

  if (countError) {
    console.error("[ADMIN_NOTIFICATION_COUNT_ERROR]", countError);
  }

  return {
    notifications: data || [],
    unreadCount: Number(count || 0),
  };
}

export async function markAdminNotificationAsRead(notificationId) {
  if (!notificationId) {
    throw new Error("ID da notificação não enviado.");
  }

  const { data, error } = await supabaseAdmin
    .from("admin_notifications")
    .update({ is_read: true })
    .eq("id", notificationId)
    .select("*")
    .single();

  if (error) {
    console.error("[ADMIN_NOTIFICATION_MARK_READ_ERROR]", error);
    throw new Error(error.message || "Erro ao marcar notificação como lida.");
  }

  return data;
}

export async function markAllAdminNotificationsAsRead() {
  const { error } = await supabaseAdmin
    .from("admin_notifications")
    .update({ is_read: true })
    .eq("is_read", false);

  if (error) {
    console.error("[ADMIN_NOTIFICATION_MARK_ALL_READ_ERROR]", error);
    throw new Error(error.message || "Erro ao marcar todas como lidas.");
  }

  return true;
}