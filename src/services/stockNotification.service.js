import { createAdminNotification } from "./adminNotifications.service.js";
import { env } from "../config/env.js";

function toStockNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
}

function getLowStockThreshold() {
  const configured = Number(env.stockLowAlertThreshold);
  if (!Number.isFinite(configured)) return 5;
  return Math.max(0, Math.trunc(configured));
}

function isStockNotificationEnabled() {
  return String(env.stockNotificationsEnabled ?? "true").trim().toLowerCase() !== "false";
}

function pluralizeUnit(value) {
  return Number(value) === 1 ? "unidade" : "unidades";
}

export function classifyStockTransition({
  previousStock,
  currentStock,
  lowStockThreshold = getLowStockThreshold(),
} = {}) {
  const previous = toStockNumber(previousStock);
  const current = toStockNumber(currentStock);
  const threshold = Math.max(0, toStockNumber(lowStockThreshold));

  if (previous > 0 && current === 0) {
    return "stock_out";
  }

  if (threshold > 0 && previous > threshold && current > 0 && current <= threshold) {
    return "stock_low";
  }

  return null;
}

export function buildStockNotificationPayload(change = {}, context = {}) {
  const previousStock = toStockNumber(change.previous_stock ?? change.previousStock);
  const currentStock = toStockNumber(change.current_stock ?? change.currentStock);
  const lowStockThreshold = getLowStockThreshold();
  const alertType = classifyStockTransition({
    previousStock,
    currentStock,
    lowStockThreshold,
  });

  if (!alertType) return null;

  const productId = String(change.product_id ?? change.productId ?? "").trim() || null;
  const productName = String(
    change.product_name ?? change.productName ?? context.productName ?? "Produto"
  ).trim() || "Produto";
  const sku = String(change.sku ?? context.sku ?? "").trim() || null;
  const orderId = String(context.orderId || context.order_id || "").trim() || null;
  const orderNumber = String(context.orderNumber || context.order_number || "").trim() || null;
  const source = String(context.source || "stock_change").trim() || "stock_change";
  const quantity = toStockNumber(change.quantity ?? change.quantity_reserved ?? 0);

  const baseMetadata = {
    source,
    product_id: productId,
    product_name: productName,
    sku,
    previous_stock: previousStock,
    current_stock: currentStock,
    low_stock_threshold: lowStockThreshold,
    quantity_changed: quantity,
    order_id: orderId,
    order_number: orderNumber,
    ...(context.metadata && typeof context.metadata === "object" ? context.metadata : {}),
  };

  if (alertType === "stock_out") {
    const sourceMessage = source.includes("order") || orderId
      ? orderNumber
        ? ` após a reserva do pedido ${orderNumber}`
        : " após uma reserva de pedido"
      : source === "admin_product_edit"
        ? " após um ajuste manual no painel"
        : "";

    return {
      type: "stock_out",
      title: "Estoque disponível esgotado",
      message: `${productName} chegou a 0 unidades${sourceMessage}.`,
      entity_type: "product",
      entity_id: productId,
      priority: "critical",
      metadata: {
        ...baseMetadata,
        alert_level: "critical",
        stock_alert_type: "stock_out",
      },
    };
  }

  return {
    type: "stock_low",
    title: "Estoque baixo",
    message: `${productName} possui apenas ${currentStock} ${pluralizeUnit(currentStock)} disponível${currentStock === 1 ? "" : "is"}.`,
    entity_type: "product",
    entity_id: productId,
    priority: "high",
    metadata: {
      ...baseMetadata,
      alert_level: "high",
      stock_alert_type: "stock_low",
    },
  };
}

export async function notifyStockTransitionsSafely(stockChanges = [], context = {}) {
  if (!isStockNotificationEnabled()) {
    return { created: 0, skipped: Array.isArray(stockChanges) ? stockChanges.length : 0 };
  }

  const changes = Array.isArray(stockChanges) ? stockChanges : [];
  let created = 0;
  let skipped = 0;

  for (const change of changes) {
    const payload = buildStockNotificationPayload(change, context);

    if (!payload) {
      skipped += 1;
      continue;
    }

    try {
      await createAdminNotification(payload);
      created += 1;
    } catch (error) {
      console.error("[STOCK_NOTIFICATION_ERROR]", {
        productId: payload.entity_id,
        type: payload.type,
        source: context?.source,
        message: error?.message || String(error),
      });
    }
  }

  return { created, skipped };
}

export async function notifySingleStockTransitionSafely(change = {}, context = {}) {
  return notifyStockTransitionsSafely([change], context);
}
