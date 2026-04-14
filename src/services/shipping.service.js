import { env } from "../config/env.js";

function normalizeBoolean(value) {
  return String(value || "").trim().toLowerCase() === "true";
}

function onlyDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

function getApiBaseUrl() {
  const configured = String(env.apiBaseUrl || "").trim();

  if (configured) {
    return configured.replace(/\/+$/, "");
  }

  return "http://localhost:5000";
}

function buildFallbackLabelUrl() {
  return `${getApiBaseUrl()}/labels/label-test.pdf`;
}

function buildFallbackResult(order, error = "") {
  const fallbackUrl = buildFallbackLabelUrl();

  return {
    success: true,
    mode: "fallback",
    labelStatus: "fallback",
    labelUrl: fallbackUrl,
    labelPdfUrl: fallbackUrl,
    trackingCode: "",
    carrier: "LOCAL",
    shipmentId: "",
    error: String(error || "").trim(),
    raw: {
      fallback: true,
      orderId: order?.id || null,
      reason: String(error || "Frenet indisponível").trim(),
      generatedAt: new Date().toISOString(),
    },
  };
}

function normalizeShippingLabelResponse(data) {
  if (!data || typeof data !== "object") return null;

  const labelUrl =
    data.ShippingLabelUrl ||
    data.shippingLabelUrl ||
    data.labelUrl ||
    data.LabelUrl ||
    "";

  const trackingCode =
    data.TrackingNumber ||
    data.trackingNumber ||
    data.trackingCode ||
    data.TrackingCode ||
    "";

  const carrier =
    data.Carrier ||
    data.carrier ||
    data.ShippingCompany ||
    data.shippingCompany ||
    "";

  const shipmentId =
    data.ShipmentId ||
    data.shipmentId ||
    data.ShippingShipmentId ||
    data.shippingShipmentId ||
    "";

  if (!String(labelUrl || "").trim()) {
    return null;
  }

  return {
    labelUrl: String(labelUrl).trim(),
    trackingCode: String(trackingCode || "").trim(),
    carrier: String(carrier || "").trim(),
    shipmentId: String(shipmentId || "").trim(),
    raw: data,
  };
}

function buildFrenetPayload(order, items = []) {
  return {
    SellerCEP: onlyDigits(env.frenetOriginZipCode),
    RecipientCEP: onlyDigits(order?.shipping_cep),
    ShipmentInvoiceValue: Number(order?.total_amount || 0),
    ShippingServiceCode: String(order?.shipping_service_code || "1").trim(),
    RecipientName: String(order?.customer_name || "").trim(),
    RecipientEmail: String(order?.customer_email || "").trim(),
    RecipientPhone: String(order?.customer_phone || "").trim(),
    RecipientAddress: String(order?.shipping_address || "").trim(),
    RecipientAddressNumber: String(order?.shipping_number || "").trim(),
    RecipientAddressComplement: String(order?.shipping_complement || "").trim(),
    RecipientNeighborhood: String(order?.shipping_neighborhood || "").trim(),
    RecipientCity: String(order?.shipping_city || "").trim(),
    RecipientState: String(order?.shipping_state || "").trim(),
    Items: (items || []).map((item) => ({
      SKU: String(item?.sku || item?.product_id || item?.id || "").trim(),
      Description: String(item?.product_name || item?.name || "Produto").trim(),
      Quantity: Number(item?.quantity || 1),
      Weight: Number(item?.weight || 1),
      Length: Number(item?.length || 10),
      Height: Number(item?.height || 10),
      Width: Number(item?.width || 10),
    })),
  };
}

export async function generateAutomaticShippingLabel(order, items = []) {
  try {
    if (!order?.id) {
      return buildFallbackResult(order, "Pedido inválido para gerar etiqueta");
    }

    if (!items?.length) {
      return buildFallbackResult(order, "Pedido sem itens para gerar etiqueta");
    }

    if (!order.shipping_cep || !order.shipping_address || !order.shipping_number) {
      return buildFallbackResult(order, "Endereço incompleto para gerar etiqueta");
    }

    const frenetToken = String(env.frenetToken || "").trim();
    const frenetLabelUrl = String(env.frenetLabelUrl || "").trim();
    const frenetSandbox = normalizeBoolean(env.frenetSandbox);

    console.log("FRENET DEBUG", {
      hasToken: Boolean(frenetToken),
      labelUrl: frenetLabelUrl || "(vazia)",
      sandbox: frenetSandbox,
      orderId: order.id,
      orderNumber: order.order_number || "",
    });

    if (!frenetToken) {
      return buildFallbackResult(order, "FRENET_TOKEN ausente");
    }

    if (!frenetLabelUrl) {
      return buildFallbackResult(order, "FRENET_LABEL_URL ausente");
    }

    if (frenetSandbox) {
      return buildFallbackResult(order, "FRENET_SANDBOX=true");
    }

    const payload = buildFrenetPayload(order, items);

    console.log("FRENET LABEL PAYLOAD:", JSON.stringify(payload, null, 2));

    const response = await fetch(frenetLabelUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        token: frenetToken,
      },
      body: JSON.stringify(payload),
    });

    const text = await response.text();
    let data = null;

    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }

    const normalized = normalizeShippingLabelResponse(data);

    if (!response.ok || !normalized) {
      return buildFallbackResult(
        order,
        !response.ok
          ? `Frenet ${response.status}: ${JSON.stringify(data)}`
          : "Resposta da Frenet sem URL de etiqueta"
      );
    }

    return {
      success: true,
      mode: "frenet",
      labelStatus: "generated",
      labelUrl: normalized.labelUrl,
      labelPdfUrl: normalized.labelUrl,
      trackingCode: normalized.trackingCode || "",
      carrier: normalized.carrier || "",
      shipmentId: normalized.shipmentId || "",
      error: "",
      raw: normalized.raw,
    };
  } catch (error) {
    console.error("ERRO FRENET LABEL:", {
      message: error.message,
    });

    return buildFallbackResult(
      order,
      error.message || "Erro ao gerar etiqueta"
    );
  }
}