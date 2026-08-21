import express from "express";
import { requireAdminAuth } from "../middlewares/auth.middleware.js";
import { requirePermission } from "../middlewares/permission.middleware.js";
import { recordAuditLog } from "../services/audit.service.js";
import {
  applyProductGoalTargets,
  applySuggestedPriceToProduct,
  calculateProductPricing,
  getProductGoalTargets,
  getPricingByProductId,
  getPricingHistoryByProductId,
  getAffiliateCommissionSettings,
  updateAffiliateCommissionSettings,
  listPaymentFeeRules,
  listPricingRecords,
  listProductsForPricing,
  saveProductPricing,
  simulatePaymentFee,
  updateProductAffiliateProgramStatus,
} from "../services/adminPricing.service.js";

const router = express.Router();

router.use(requireAdminAuth);

const requirePricingView = requirePermission("pricing.view");
const requirePricingEdit = requirePermission("pricing.edit");

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
    affiliate_program_enabled: record.affiliate_program_enabled !== false,
    goal_funding_mode: record.goal_funding_mode || null,
    goal_bonus_per_sale: toMoney(record.goal_bonus_per_sale),
    worst_goal_bonus_per_sale: toMoney(record.worst_goal_bonus_per_sale),
    worst_goal_level_name: record.worst_goal_level_name || null,
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

router.get("/products", requirePricingView, async (req, res) => {
  try {
    const search = req.query.search || "";
    const products = await listProductsForPricing(search);
    return ok(res, { products });
  } catch (error) {
    return fail(res, error);
  }
});

router.get("/", requirePricingView, async (req, res) => {
  try {
    const records = await listPricingRecords();
    return ok(res, { records });
  } catch (error) {
    return fail(res, error);
  }
});

router.get("/affiliate-settings", requirePricingView, async (req, res) => {
  try {
    const settings = await getAffiliateCommissionSettings();
    return ok(
      res,
      { settings },
      "Configurações globais de comissão carregadas com sucesso."
    );
  } catch (error) {
    return fail(res, error);
  }
});

router.patch("/affiliate-settings", requirePricingEdit, async (req, res) => {
  try {
    const previousSettings = await getAffiliateCommissionSettings();
    const settings = await updateAffiliateCommissionSettings(
      req.body || {},
      req.admin?.id || req.admin?.userId || null
    );

    await recordAuditSafely({
      req,
      action: "affiliate_global_commission_updated",
      module: "pricing",
      entityType: "affiliate_commission_settings",
      entityId: "global",
      description: [
        settings.fixed_commission_enabled
          ? `Comissão direta global: ${settings.fixed_commission_percent}%.`
          : "Comissão direta global desativada.",
        settings.fixed_recruitment_commission_enabled
          ? `Comissão global de recrutamento: ${settings.fixed_recruitment_commission_percent}%.`
          : "Comissão global de recrutamento desativada.",
      ].join(" "),
      oldValues: previousSettings,
      newValues: settings,
      metadata: {
        source: "admin_pricing_affiliate_settings",
      },
    });

    return ok(
      res,
      { settings },
      "Configurações globais de comissão atualizadas com sucesso."
    );
  } catch (error) {
    return fail(res, error, 400);
  }
});

/**
 * Lista as taxas ativas do Mercado Pago cadastradas no Supabase.
 * Rota protegida:
 * GET /api/admin/pricing/payment-fees
 */
router.get("/payment-fees", requirePricingView, async (req, res) => {
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
router.post("/simulate-payment-fee", requirePricingView, async (req, res) => {
  try {
    const simulation = await simulatePaymentFee(req.body || {});
    return ok(res, { simulation }, "Taxa simulada com sucesso.");
  } catch (error) {
    return fail(res, error, 400);
  }
});

router.get("/product/:productId", requirePricingView, async (req, res) => {
  try {
    const record = await getPricingByProductId(req.params.productId);
    return ok(res, { record });
  } catch (error) {
    return fail(res, error);
  }
});

router.get("/product/:productId/goal-targets", requirePricingView, async (req, res) => {
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
router.get("/product/:productId/history", requirePricingView, async (req, res) => {
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
router.get("/history/:productId", requirePricingView, async (req, res) => {
  try {
    const history = await getPricingHistoryByProductId(req.params.productId);
    return ok(res, { history });
  } catch (error) {
    return fail(res, error);
  }
});

router.post("/calculate", requirePricingView, async (req, res) => {
  try {
    const pricing = await calculateProductPricing(req.body || {});
    return ok(res, { pricing }, "Precificação calculada com sucesso.");
  } catch (error) {
    return fail(res, error, 400);
  }
});

router.post("/save", requirePricingEdit, async (req, res) => {
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

router.patch(
  "/product/:productId/affiliate-program",
  requirePricingEdit,
  async (req, res) => {
    try {
      const productId = req.params.productId;
      const previousRecord = await getPricingByProductId(productId);
      const enabled =
        req.body?.affiliate_program_enabled ??
        req.body?.affiliateProgramEnabled;
      const record = await updateProductAffiliateProgramStatus(
        productId,
        enabled
      );

      await recordAuditSafely({
        req,
        action:
          record.affiliate_program_enabled === true
            ? "affiliate_program_enabled"
            : "affiliate_program_disabled",
        module: "pricing",
        entityType: "product",
        entityId: productId,
        description:
          record.affiliate_program_enabled === true
            ? "Produto incluído no programa de afiliados."
            : "Produto removido do programa de afiliados.",
        oldValues: buildPricingSnapshot(previousRecord),
        newValues: buildPricingSnapshot(record),
        metadata: {
          source: "admin_pricing_affiliate_program_toggle",
          pricing_id: record.id || null,
        },
      });

      return ok(
        res,
        { record },
        record.affiliate_program_enabled === true
          ? "Produto incluído no programa de afiliados."
          : "Produto removido do programa de afiliados."
      );
    } catch (error) {
      return fail(res, error, 400);
    }
  }
);

router.post("/product/:productId/goal-targets/apply", requirePricingEdit, async (req, res) => {
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

router.post("/apply/:productId", requirePricingEdit, async (req, res) => {
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