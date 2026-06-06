import { supabaseAdmin } from "../config/supabase.js";

const TABLE_NAME = "admin_audit_logs";

function clamp(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(number)));
}

function cleanText(value, maxLength = 120) {
  return String(value || "")
    .trim()
    .replace(/[(),]/g, " ")
    .replace(/\s+/g, " ")
    .slice(0, maxLength);
}

function applyFilters(query, filters = {}) {
  const moduleName = cleanText(filters.module, 60);
  const status = cleanText(filters.status, 20);
  const action = cleanText(filters.action, 80);
  const adminId = cleanText(filters.adminId, 80);
  const dateFrom = cleanText(filters.dateFrom, 40);
  const dateTo = cleanText(filters.dateTo, 40);
  const search = cleanText(filters.search, 100);

  if (moduleName && moduleName !== "all") query = query.eq("module", moduleName);
  if (status && status !== "all") query = query.eq("status", status);
  if (action && action !== "all") query = query.eq("action", action);
  if (adminId && adminId !== "all") query = query.eq("admin_id", adminId);
  if (dateFrom) query = query.gte("created_at", dateFrom);
  if (dateTo) query = query.lte("created_at", dateTo);

  if (search) {
    const pattern = `%${search}%`;
    query = query.or(
      [
        `description.ilike.${pattern}`,
        `actor_email.ilike.${pattern}`,
        `actor_name.ilike.${pattern}`,
        `entity_id.ilike.${pattern}`,
        `action.ilike.${pattern}`,
        `module.ilike.${pattern}`,
      ].join(",")
    );
  }

  return query;
}

export function isAuditTableMissing(error) {
  const code = String(error?.code || "").toUpperCase();
  const message = String(error?.message || "").toLowerCase();

  return (
    code === "42P01" ||
    code === "PGRST205" ||
    (message.includes(TABLE_NAME) &&
      (message.includes("does not exist") || message.includes("schema cache")))
  );
}

export async function listAuditLogs(filters = {}) {
  const page = clamp(filters.page, 1, 100000, 1);
  const limit = clamp(filters.limit, 1, 100, 25);
  const from = (page - 1) * limit;
  const to = from + limit - 1;

  let query = supabaseAdmin
    .from(TABLE_NAME)
    .select("*", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(from, to);

  query = applyFilters(query, filters);

  const { data, error, count } = await query;

  if (error) throw error;

  return {
    logs: Array.isArray(data) ? data : [],
    pagination: {
      page,
      limit,
      total: Number(count || 0),
      pages: Math.max(1, Math.ceil(Number(count || 0) / limit)),
    },
  };
}

async function countByFilter(filterBuilder) {
  let query = supabaseAdmin
    .from(TABLE_NAME)
    .select("id", { count: "exact", head: true });

  if (typeof filterBuilder === "function") {
    query = filterBuilder(query);
  }

  const { count, error } = await query;
  if (error) throw error;
  return Number(count || 0);
}

export async function getAuditSummary() {
  const last24Hours = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const last7Days = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const [total, last24h, last7d, failures] = await Promise.all([
    countByFilter(),
    countByFilter((query) => query.gte("created_at", last24Hours)),
    countByFilter((query) => query.gte("created_at", last7Days)),
    countByFilter((query) => query.eq("status", "failure")),
  ]);

  return { total, last24h, last7d, failures };
}

export async function getAuditFilterOptions() {
  const { data, error } = await supabaseAdmin
    .from(TABLE_NAME)
    .select("module,action,admin_id,actor_name,actor_email")
    .order("created_at", { ascending: false })
    .limit(500);

  if (error) throw error;

  const rows = Array.isArray(data) ? data : [];
  const modules = [...new Set(rows.map((item) => item.module).filter(Boolean))].sort();
  const actions = [...new Set(rows.map((item) => item.action).filter(Boolean))].sort();
  const adminsById = new Map();

  rows.forEach((item) => {
    if (!item.admin_id || adminsById.has(item.admin_id)) return;
    adminsById.set(item.admin_id, {
      id: item.admin_id,
      name: item.actor_name || item.actor_email || "Administrador",
      email: item.actor_email || "",
    });
  });

  return {
    modules,
    actions,
    admins: Array.from(adminsById.values()),
  };
}

export async function insertAuditLog(payload) {
  const { data, error } = await supabaseAdmin
    .from(TABLE_NAME)
    .insert(payload)
    .select("*")
    .single();

  if (error) throw error;
  return data;
}

export async function findAuditLogById(id) {
  const { data, error } = await supabaseAdmin
    .from(TABLE_NAME)
    .select("id")
    .eq("id", String(id || "").trim())
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

export async function deleteAuditLogById(id) {
  const { error } = await supabaseAdmin
    .from(TABLE_NAME)
    .delete()
    .eq("id", String(id || "").trim());

  if (error) throw error;
  return true;
}
