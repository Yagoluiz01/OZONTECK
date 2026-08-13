import express from "express";
import crypto from "crypto";
import rateLimit from "express-rate-limit";
import { env } from "../config/env.js";
import { supabaseAdmin } from "../config/supabase.js";
import { requireAdminAuth } from "../middlewares/auth.middleware.js";
import { requireMasterAdmin } from "../middlewares/masterAdmin.middleware.js";

const router = express.Router();

const RESUME_TTL_MINUTES = Math.max(
  15,
  Math.min(24 * 60, Number(process.env.ORDER_RESUME_TTL_MINUTES || 24 * 60))
);

const exchangeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Muitas tentativas de retomada. Aguarde alguns minutos.",
  },
});

function normalizeText(value, maxLength = 240) {
  const text = String(value || "").trim().slice(0, Math.max(1, maxLength));
  return text || null;
}

function base64urlEncode(value) {
  return Buffer.from(value).toString("base64url");
}

function base64urlDecode(value) {
  return Buffer.from(String(value || ""), "base64url").toString("utf8");
}

function resumeSecret() {
  return String(
    process.env.ORDER_RESUME_SECRET ||
    env.jwtSecret ||
    process.env.JWT_SECRET ||
    ""
  ).trim();
}

function signPayload(encodedPayload) {
  const secret = resumeSecret();
  if (!secret) throw new Error("ORDER_RESUME_SECRET/JWT_SECRET não configurado.");
  return crypto.createHmac("sha256", secret).update(encodedPayload).digest("base64url");
}

function createResumeToken({ orderNumber, sessionId }) {
  const payload = {
    v: 1,
    order_number: orderNumber,
    session_id: sessionId || null,
    nonce: crypto.randomBytes(12).toString("hex"),
    iat: Date.now(),
    exp: Date.now() + RESUME_TTL_MINUTES * 60 * 1000,
  };

  const encoded = base64urlEncode(JSON.stringify(payload));
  return `${encoded}.${signPayload(encoded)}`;
}

function verifyResumeToken(token) {
  const [encoded, signature, extra] = String(token || "").split(".");
  if (!encoded || !signature || extra) return null;

  const expected = signPayload(encoded);
  const providedBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);

  if (
    providedBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(providedBuffer, expectedBuffer)
  ) {
    return null;
  }

  let payload = null;
  try {
    payload = JSON.parse(base64urlDecode(encoded));
  } catch {
    return null;
  }

  if (
    payload?.v !== 1 ||
    !payload?.order_number ||
    !Number.isFinite(Number(payload?.exp)) ||
    Date.now() > Number(payload.exp)
  ) {
    return null;
  }

  return payload;
}

function hashOrderAccessToken(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function isPaidStatus(value) {
  return [
    "paid",
    "pago",
    "approved",
    "aprovado",
    "confirmed",
    "confirmado",
    "completed",
    "complete",
  ].includes(String(value || "").trim().toLowerCase());
}

function isTerminalBlockedStatus(value) {
  return [
    "cancelled",
    "canceled",
    "cancelado",
    "refunded",
    "reembolsado",
    "chargeback",
  ].includes(String(value || "").trim().toLowerCase());
}

function safeJsonParse(value, fallback = {}) {
  try {
    const parsed = JSON.parse(String(value || ""));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function storeFrontendBaseUrl() {
  return String(
    process.env.STORE_FRONTEND_URL ||
    process.env.FRONTEND_URL ||
    "https://ozonteck-loja.onrender.com"
  ).trim().replace(/\/+$/, "");
}

async function loadOrder(orderNumber) {
  const { data, error } = await supabaseAdmin
    .from("orders")
    .select(
      "id,order_number,customer_name,subtotal,shipping_amount,discount_amount,total_amount,payment_status,order_status,payment_gateway,payment_reference,shipping_carrier,shipping_service_code,shipping_service_name,shipping_delivery_time,shipping_city,shipping_state,created_at,paid_at"
    )
    .eq("order_number", orderNumber)
    .limit(1);

  if (error) throw error;
  return Array.isArray(data) && data.length ? data[0] : null;
}

async function loadOrderItems(orderId) {
  if (!orderId) return [];

  const { data, error } = await supabaseAdmin
    .from("order_items")
    .select("product_id,product_name,sku,unit_price,quantity,total_price")
    .eq("order_id", orderId)
    .order("created_at", { ascending: true });

  if (error) throw error;

  return (Array.isArray(data) ? data : []).map((item) => ({
    id: item.product_id || item.sku || null,
    name: normalizeText(item.product_name, 180) || "Produto OZONTECK",
    sku: normalizeText(item.sku, 100),
    price: Number(item.unit_price || 0),
    quantity: Math.max(1, Number(item.quantity || 1)),
    total: Number(item.total_price || 0),
  }));
}

async function loadOrderEventForSession(sessionId, orderNumber) {
  if (!sessionId) return null;

  const { data, error } = await supabaseAdmin
    .from("lead_events")
    .select("id,session_id,visitor_id,event_type,section,created_at")
    .eq("session_id", sessionId)
    .eq("event_type", "checkout_order_created")
    .order("created_at", { ascending: false })
    .limit(20);

  if (error) throw error;

  return (Array.isArray(data) ? data : []).find((row) => {
    const meta = safeJsonParse(row.section, {});
    const value = normalizeText(
      meta.order_number ||
      meta.orderNumber ||
      meta.external_reference ||
      meta.externalReference,
      180
    );
    return value === orderNumber;
  }) || null;
}

router.post(
  "/admin-link",
  requireAdminAuth,
  requireMasterAdmin,
  async (req, res) => {
    try {
      const orderNumber = normalizeText(
        req.body?.order_number || req.body?.orderNumber,
        180
      );
      const sessionId = normalizeText(
        req.body?.session_id || req.body?.sessionId,
        180
      );

      if (!orderNumber) {
        return res.status(400).json({
          success: false,
          message: "Pedido não informado.",
        });
      }

      const order = await loadOrder(orderNumber);
      if (!order?.id) {
        return res.status(404).json({
          success: false,
          message: "Pedido não encontrado.",
        });
      }

      if (isPaidStatus(order.payment_status)) {
        return res.status(409).json({
          success: false,
          code: "ORDER_ALREADY_PAID",
          message: "Este pedido já está pago.",
        });
      }

      if (isTerminalBlockedStatus(order.order_status)) {
        return res.status(409).json({
          success: false,
          code: "ORDER_NOT_RESUMABLE",
          message: "Este pedido não pode mais ser retomado.",
        });
      }

      // Quando a recuperação veio de uma sessão conhecida, confirme que o pedido
      // realmente pertence àquela sessão de checkout antes de gerar o link.
      if (sessionId) {
        const event = await loadOrderEventForSession(sessionId, orderNumber);
        if (!event) {
          return res.status(409).json({
            success: false,
            code: "ORDER_SESSION_MISMATCH",
            message: "O pedido não corresponde à sessão selecionada.",
          });
        }
      }

      const token = createResumeToken({ orderNumber, sessionId });
      const url = `${storeFrontendBaseUrl()}/pages-html/pagamento.html?resume=${encodeURIComponent(token)}`;

      res.setHeader("Cache-Control", "private, no-store, max-age=0");
      return res.status(200).json({
        success: true,
        order_number: orderNumber,
        resume_url: url,
        expires_in_minutes: RESUME_TTL_MINUTES,
      });
    } catch (error) {
      console.error("[ORDER_RESUME_ADMIN_LINK_ERROR]", error);
      return res.status(500).json({
        success: false,
        message: "Não foi possível criar o link seguro de retomada.",
      });
    }
  }
);

router.post("/exchange", exchangeLimiter, async (req, res) => {
  try {
    const payload = verifyResumeToken(req.body?.token);
    if (!payload) {
      return res.status(401).json({
        success: false,
        code: "INVALID_OR_EXPIRED_RESUME_TOKEN",
        message: "Este link de retomada expirou ou não é válido.",
      });
    }

    const order = await loadOrder(payload.order_number);
    if (!order?.id) {
      return res.status(404).json({
        success: false,
        message: "Pedido não encontrado.",
      });
    }

    if (isTerminalBlockedStatus(order.order_status)) {
      return res.status(409).json({
        success: false,
        code: "ORDER_NOT_RESUMABLE",
        message: "Este pedido não pode mais ser retomado.",
      });
    }

    const items = await loadOrderItems(order.id);

    // Troca o bearer temporário por um token forte de acesso ao pedido.
    // O token real nunca fica na URL. Após a troca, a página remove ?resume=...
    // imediatamente do histórico/endereço.
    const accessToken = crypto.randomBytes(32).toString("hex");
    const accessTokenHash = hashOrderAccessToken(accessToken);

    const { error: updateError } = await supabaseAdmin
      .from("orders")
      .update({ public_access_token_hash: accessTokenHash })
      .eq("id", order.id);

    if (updateError) throw updateError;

    if (payload.session_id) {
      await supabaseAdmin
        .from("lead_events")
        .insert({
          session_id: payload.session_id,
          event_type: "order_resume_opened",
          page: "pagamento.html",
          section: JSON.stringify({
            order_number: order.order_number,
            source: "lead_recovery",
          }),
          duration_ms: 0,
        })
        .catch(() => null);
    }

    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    return res.status(200).json({
      success: true,
      converted: isPaidStatus(order.payment_status),
      order: {
        number: order.order_number,
        customerName: normalizeText(order.customer_name, 160),
        subtotal: Number(order.subtotal || 0),
        shippingAmount: Number(order.shipping_amount || 0),
        discountAmount: Number(order.discount_amount || 0),
        total: Number(order.total_amount || 0),
        paymentStatus: order.payment_status || null,
        status: order.order_status || null,
        paymentGateway: order.payment_gateway || null,
        paymentId: order.payment_reference || null,
        paidAt: order.paid_at || null,
        shipping: {
          carrier: normalizeText(order.shipping_carrier, 120),
          serviceCode: normalizeText(order.shipping_service_code, 120),
          serviceName: normalizeText(order.shipping_service_name, 160),
          deliveryTime: Number.isFinite(Number(order.shipping_delivery_time))
            ? Number(order.shipping_delivery_time)
            : null,
          city: normalizeText(order.shipping_city, 120),
          state: normalizeText(order.shipping_state, 40),
        },
        items,
        accessToken,
      },
    });
  } catch (error) {
    console.error("[ORDER_RESUME_EXCHANGE_ERROR]", error);
    return res.status(500).json({
      success: false,
      message: "Não foi possível retomar este pedido agora.",
    });
  }
});

router.get(
  "/converted-leads",
  requireAdminAuth,
  requireMasterAdmin,
  async (req, res) => {
    try {
      const days = Math.min(90, Math.max(1, Number(req.query.days || 30)));
      const sinceIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

      const { data: orderEvents, error: eventError } = await supabaseAdmin
        .from("lead_events")
        .select("session_id,visitor_id,section,created_at")
        .eq("event_type", "checkout_order_created")
        .gte("created_at", sinceIso)
        .order("created_at", { ascending: false })
        .limit(1000);

      if (eventError) throw eventError;

      const parsedEvents = (Array.isArray(orderEvents) ? orderEvents : [])
        .map((row) => {
          const meta = safeJsonParse(row.section, {});
          return {
            session_id: row.session_id,
            visitor_id: row.visitor_id,
            created_at: row.created_at,
            order_number: normalizeText(
              meta.order_number ||
              meta.orderNumber ||
              meta.external_reference ||
              meta.externalReference,
              180
            ),
          };
        })
        .filter((row) => row.session_id && row.order_number);

      const orderNumbers = [...new Set(parsedEvents.map((row) => row.order_number))];
      if (!orderNumbers.length) {
        return res.status(200).json({ success: true, data: [] });
      }

      const { data: orders, error: ordersError } = await supabaseAdmin
        .from("orders")
        .select("order_number,payment_status,order_status,total_amount,paid_at,created_at")
        .in("order_number", orderNumbers)
        .order("paid_at", { ascending: false })
        .limit(1000);

      if (ordersError) throw ordersError;

      const paidByNumber = new Map(
        (Array.isArray(orders) ? orders : [])
          .filter((order) => isPaidStatus(order.payment_status))
          .map((order) => [String(order.order_number), order])
      );

      const paidEvents = parsedEvents.filter((row) => paidByNumber.has(row.order_number));
      const sessionIds = [...new Set(paidEvents.map((row) => row.session_id))];

      const contactBySession = new Map();
      if (sessionIds.length) {
        const { data: contacts } = await supabaseAdmin
          .from("lead_events")
          .select("session_id,section,created_at")
          .in("session_id", sessionIds)
          .eq("event_type", "checkout_contact")
          .order("created_at", { ascending: false })
          .limit(Math.min(1500, sessionIds.length * 6));

        for (const row of Array.isArray(contacts) ? contacts : []) {
          if (!row?.session_id || contactBySession.has(row.session_id)) continue;
          const meta = safeJsonParse(row.section, {});
          const contact = meta.contact && typeof meta.contact === "object" ? meta.contact : {};
          const checkout = meta.checkout && typeof meta.checkout === "object" ? meta.checkout : {};
          contactBySession.set(row.session_id, {
            name: normalizeText(contact.name || contact.nome, 120),
            phone: normalizeText(contact.phone || contact.telefone, 40),
            product_summary: normalizeText(checkout.product_summary, 240),
          });
        }
      }

      const seen = new Set();
      const converted = [];

      for (const event of paidEvents) {
        if (seen.has(event.order_number)) continue;
        seen.add(event.order_number);

        const order = paidByNumber.get(event.order_number);
        const contact = contactBySession.get(event.session_id) || {};

        converted.push({
          session_id: event.session_id,
          visitor_id: event.visitor_id || null,
          order_number: event.order_number,
          name: contact.name || null,
          phone: contact.phone || null,
          product_summary: contact.product_summary || null,
          total: Number(order?.total_amount || 0),
          payment_status: order?.payment_status || "paid",
          order_status: order?.order_status || null,
          created_at: order?.created_at || event.created_at,
          paid_at: order?.paid_at || order?.created_at || event.created_at,
        });
      }

      converted.sort(
        (a, b) => Date.parse(b.paid_at || 0) - Date.parse(a.paid_at || 0)
      );

      res.setHeader("Cache-Control", "private, no-store, max-age=0");
      return res.status(200).json({
        success: true,
        data: converted.slice(0, 100),
      });
    } catch (error) {
      console.error("[ORDER_RESUME_CONVERTED_LEADS_ERROR]", error);
      return res.status(500).json({
        success: false,
        message: "Não foi possível carregar os leads convertidos.",
      });
    }
  }
);

export default router;
