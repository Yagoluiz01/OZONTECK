import express from "express";
import { requireAdminAuth } from "../middlewares/auth.middleware.js";
import {
  applySuggestedPriceToProduct,
  calculateProductPricing,
  getPricingByProductId,
  getPricingHistoryByProductId,
  listPaymentFeeRules,
  listPricingRecords,
  listProductsForPricing,
  saveProductPricing,
  simulatePaymentFee,
} from "../services/adminPricing.service.js";

const router = express.Router();

router.use(requireAdminAuth);

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
    const record = await saveProductPricing(req.body || {});
    return ok(res, { record }, "Precificação salva com sucesso.");
  } catch (error) {
    return fail(res, error, 400);
  }
});

router.post("/apply/:productId", async (req, res) => {
  try {
    const result = await applySuggestedPriceToProduct(req.params.productId, req.body || {});
    return ok(res, result, "Preço sugerido aplicado ao produto com sucesso.");
  } catch (error) {
    return fail(res, error, 400);
  }
});

export default router;