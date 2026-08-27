import crypto from "node:crypto";

import { supabaseAdmin } from "../config/supabase.js";

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{40,100}$/;

function cleanToken(value) {
  const token = String(value || "").trim();
  return TOKEN_PATTERN.test(token) ? token : "";
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function officialOrderRevenue(order) {
  const amount = Number(order?.total_amount || 0);
  return Number.isFinite(amount) && amount >= 0 ? Number(amount.toFixed(2)) : 0;
}

export async function recordMarketingOrderAttribution(
  { orderId, token } = {},
  { client = supabaseAdmin } = {}
) {
  const safeOrderId = String(orderId || "").trim();
  const safeToken = cleanToken(token);
  if (!safeOrderId || !safeToken) return null;

  const now = new Date().toISOString();
  const { data: clickLink, error: clickError } = await client
    .from("marketing_click_links")
    .select("campaign_id,recipient_id,last_clicked_at,expires_at")
    .eq("token_hash", hashToken(safeToken))
    .gt("expires_at", now)
    .not("last_clicked_at", "is", null)
    .maybeSingle();

  if (clickError) throw clickError;
  if (!clickLink?.campaign_id || !clickLink?.recipient_id) return null;

  const attribution = {
    order_id: safeOrderId,
    campaign_id: clickLink.campaign_id,
    recipient_id: clickLink.recipient_id,
    attribution_type: "last_click",
    status: "pending",
    attributed_revenue: 0,
    clicked_at: clickLink.last_clicked_at,
    converted_at: null,
  };
  const { data, error } = await client
    .from("marketing_order_attributions")
    .upsert(attribution, { onConflict: "order_id" })
    .select("*")
    .single();
  if (error) throw error;

  const { error: eventError } = await client
    .from("marketing_campaign_events")
    .upsert({
      campaign_id: data.campaign_id,
      recipient_id: data.recipient_id,
      event_type: "order_created",
      event_key: `order:created:${safeOrderId}`,
      metadata: { attribution: "last_click" },
      occurred_at: now,
    }, { onConflict: "event_key", ignoreDuplicates: true });
  if (eventError) throw eventError;

  return data;
}

export async function finalizeMarketingOrderAttribution(
  order,
  { client = supabaseAdmin } = {}
) {
  const orderId = String(order?.id || "").trim();
  if (!orderId) return null;

  const { data: current, error: currentError } = await client
    .from("marketing_order_attributions")
    .select("*")
    .eq("order_id", orderId)
    .maybeSingle();
  if (currentError) throw currentError;
  if (!current) return null;
  if (current.status === "converted") return current;

  const convertedAt = String(order?.paid_at || "").trim() || new Date().toISOString();
  const { data, error } = await client
    .from("marketing_order_attributions")
    .update({
      status: "converted",
      attributed_revenue: officialOrderRevenue(order),
      converted_at: convertedAt,
    })
    .eq("id", current.id)
    .eq("status", "pending")
    .select("*")
    .maybeSingle();
  if (error) throw error;

  const finalized = data || current;
  const { error: eventError } = await client
    .from("marketing_campaign_events")
    .upsert({
      campaign_id: finalized.campaign_id,
      recipient_id: finalized.recipient_id,
      event_type: "order_paid",
      event_key: `order:paid:${orderId}`,
      metadata: {
        attribution: "last_click",
        attributed_revenue: officialOrderRevenue(order),
      },
      occurred_at: convertedAt,
    }, { onConflict: "event_key", ignoreDuplicates: true });
  if (eventError) throw eventError;

  return finalized;
}
