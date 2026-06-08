import express from "express";
import { requireAdminAuth } from "../middlewares/auth.middleware.js";
import { requireMasterAdmin } from "../middlewares/masterAdmin.middleware.js";
import { recordAuditLog } from "../services/audit.service.js";
import {
  applyProductGoalTargets,
  applySuggestedPriceToProduct,
  calculateProductPricing,
  getProductGoalTargets,
  getPricingByProductId,
  getPricingHistoryByProductId,
  listPaymentFeeRules,
  listPricingRecords,
  listProductsForPricing,
  saveProductPricing,
  simulatePaymentFee,
} from "../services/adminPricing.service.js";

const router = express.Router();

router.use(requireAdminAuth, requireMasterAdmin);

function toMoney(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Number(number.toFixed(2)) : 0;
}

function getJoinedProduct(record = {}) {
  if (Array.isArray(record?.products)) return record.products[0] || null;
  return record?.products || null;
}

function buildPricingSnapshot(record = {}) {
  if (!record || typeof record !== "object") return null;

  return {
    cost_price: toMoney(record.cost_price),
    packaging_cost: toMoney(record.packaging_cost),
    traffic_cost: toMoney(record.traffic_cost),
    other_costs: toMoney(record.other_costs),
    operational_cost: toMoney(record.operational_cost),
    gateway_fee_percent: toMoney(record.gateway_fee_percent),
    tax_percent: toMoney(record.tax_percent),
    desired_margin_percent: toMoney(record.desired_margin_percent),
    affiliate_commission_percent: toMoney(record.affiliate_commission_percent),
    network_commission_percent: toMoney(record.network_commission_percent),
    safe_price: toMoney(record.safe_price),
    suggested_price: toMoney(record.suggested_price),
    status: record.status || null,
    notes: record.notes || null,
  };
}

function snapshotsDiffer(before, after) {
  return JSON.stringify(before || null) !== JSON.stringify(after || null);
}

async function recordAuditSafely(payload) {
  try {
    await recordAuditLog(payload);
  } catch (error) {
    console.error("[ADMIN_PRICING_AUDIT_ERROR]", {
      action: payload?.action,
      entityId: payload?.entityId,
      message: error?.message || String(error),
    });
  }
}

function ok(res, data = {}, message = "OK") {
  return res.status(200).json({
    success: true,
    message,
    ...data,
  });
}

function fail(res, error, status = 500) {
  return res.status(status).json({
    success: false,
    message: error?.message || "Erro interno.",
  });
}

router.get("/products", async (req, res) => {
  try {
    const search = req.query.search || "";
    const products = await listProductsForPricing(search);
    return ok(res, { products });
  } catch (error) {
    return fail(res, error);
  }
});

router.get("/", async (req, res) => {
  try {
    const records = await listPricingRecords();
    return ok(res, { records });
  } catch (error) {
    return fail(res, error);
  }
});

/**
 * Lista as taxas ativas do Mercado Pago cadastradas no Supabase.
 * Rota protegida:
 * GET /api/admin/pricing/payment-fees
 */
router.get("/payment-fees", async (req, res) => {
  try {
    const fees = await listPaymentFeeRules();
    return ok(res, { fees }, "Taxas de pagamento carregadas com sucesso.");
  } catch (error) {
    return fail(res, error);
  }
});

/**
 * Simula a taxa do Mercado Pago para um valor específico.
 * Rota protegida:
 * POST /api/admin/pricing/simulate-payment-fee
 */
router.post("/simulate-payment-fee", async (req, res) => {
  try {
    const simulation = await simulatePaymentFee(req.body || {});
    return ok(res, { simulation }, "Taxa simulada com sucesso.");
  } catch (error) {
    return fail(res, error, 400);
  }
});

router.get("/product/:productId", async (req, res) => {
  try {
    const record = await getPricingByProductId(req.params.productId);
    return ok(res, { record });
  } catch (error) {
    return fail(res, error);
  }
});

router.get("/product/:productId/goal-targets", async (req, res) => {
  try {
    const targets = await getProductGoalTargets(req.params.productId);
    return ok(res, { targets }, "Metas específicas do produto carregadas com sucesso.");
  } catch (error) {
    return fail(res, error, 400);
  }
});

/**
 * Mantém compatibilidade com o frontend atual:
 * /api/admin/pricing/product/:productId/history
 */
router.get("/product/:productId/history", async (req, res) => {
  try {
    const history = await getPricingHistoryByProductId(req.params.productId);
    return ok(res, { history });
  } catch (error) {
    return fail(res, error);
  }
});

/**
 * Mantém compatibilidade com rota antiga:
 * /api/admin/pricing/history/:productId
 */
router.get("/history/:productId", async (req, res) => {
  try {
    const history = await getPricingHistoryByProductId(req.params.productId);
    return ok(res, { history });
  } catch (error) {
    return fail(res, error);
  }
});

router.post("/calculate", async (req, res) => {
  try {
    const pricing = await calculateProductPricing(req.body || {});
    return ok(res, { pricing }, "Precificação calculada com sucesso.");
  } catch (error) {
    return fail(res, error, 400);
  }
});

router.post("/save", async (req, res) => {
  try {
    const payload = req.body || {};
    const productId = payload.product_id || payload.productId;
    const previousRecord = productId
      ? await getPricingByProductId(productId)
      : null;
    const record = await saveProductPricing(payload);

    const previousSnapshot = buildPricingSnapshot(previousRecord);
    const currentSnapshot = buildPricingSnapshot(record);

    if (productId && record && snapshotsDiffer(previousSnapshot, currentSnapshot)) {
      const product = getJoinedProduct(previousRecord);

      await recordAuditSafely({
        req,
        action: previousRecord ? "pricing_updated" : "pricing_created",
        module: "pricing",
        entityType: "product_pricing",
        entityId: productId,
        description: previousRecord
          ? `Precificação do produto ${product?.name || productId} foi atualizada.`
          : `Precificação do produto ${product?.name || productId} foi criada.`,
        oldValues: previousSnapshot,
        newValues: currentSnapshot,
        metadata: {
          source: "admin_pricing_save",
          pricing_id: record.id || null,
          product_name: product?.name || null,
          product_sku: product?.sku || null,
        },
      });
    }

    return ok(res, { record }, "Precificação salva com sucesso.");
  } catch (error) {
    return fail(res, error, 400);
  }
});

router.post("/product/:productId/goal-targets/apply", async (req, res) => {
  try {
    const productId = req.params.productId;
    const previousTargets = await getProductGoalTargets(productId).catch(() => []);
    const result = await applyProductGoalTargets(productId, {
      actorId: req.admin?.id || req.admin?.userId || null,
    });

    await recordAuditSafely({
      req,
      action: "product_goal_targets_applied",
      module: "pricing",
      entityType: "product",
      entityId: productId,
      description: `Metas seguras específicas do produto ${
        result?.product?.name || productId
      } foram aplicadas.`,
      oldValues: {
        targets: previousTargets.map((target) => ({
          level_id: target.affiliate_level_id,
          required_units: target.required_units,
          is_active: target.is_active,
        })),
      },
      newValues: {
        targets: result.targets.map((target) => ({
          level_id: target.affiliate_level_id,
          required_units: target.required_units,
          is_active: target.is_active,
        })),
      },
      metadata: {
        source: "admin_pricing_product_goal_targets",
        product_name: result?.product?.name || null,
        product_sku: result?.product?.sku || null,
        pricing_id: result?.pricing_id || null,
      },
    });

    return ok(
      res,
      result,
      "Meta segura aplicada somente a este produto com sucesso."
    );
  } catch (error) {
    return fail(res, error, 400);
  }
});

router.post("/apply/:productId", async (req, res) => {
  try {
    const productId = req.params.productId;
    const previousRecord = await getPricingByProductId(productId);
    const previousProduct = getJoinedProduct(previousRecord);
    const previousPrice = toMoney(previousProduct?.price);

    const result = await applySuggestedPriceToProduct(productId, req.body || {});
    const currentPrice = toMoney(result?.product?.price);

    if (previousPrice !== currentPrice) {
      await recordAuditSafely({
        req,
        action: "product_price_changed",
        module: "pricing",
        entityType: "product",
        entityId: productId,
        description: `Preço do produto ${
          result?.product?.name || previousProduct?.name || productId
        } foi alterado pela precificação.`,
        oldValues: {
          price: previousPrice,
        },
        newValues: {
          price: currentPrice,
        },
        metadata: {
          source: "admin_pricing_apply",
          pricing_id: result?.pricing?.id || previousRecord?.id || null,
          product_name: result?.product?.name || previousProduct?.name || null,
          product_sku: result?.product?.sku || previousProduct?.sku || null,
        },
      });
    }

    return ok(res, result, "Preço sugerido aplicado ao produto com sucesso.");
  } catch (error) {
    return fail(res, error, 400);
  }
});

export default router;