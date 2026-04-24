import express from "express";
import {
  listFinancialCategories,
  createFinancialCategory,
  updateFinancialCategory,
  listAccountsPayable,
  createAccountPayable,
  updateAccountPayable,
  listAccountsReceivable,
  createAccountReceivable,
  updateAccountReceivable,
  listFinancialOrders,
  getFinancialSummary,
  syncOrderFinancialData,
} from "../services/adminFinancial.service.js";

const router = express.Router();

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

/**
 * RESUMO
 */
router.get("/summary", async (req, res) => {
  try {
    const period = req.query.period || "30d";
    const summary = await getFinancialSummary(period);
    return ok(res, { summary });
  } catch (error) {
    return fail(res, error);
  }
});

/**
 * PEDIDOS
 */
router.get("/orders", async (req, res) => {
  try {
    const period = req.query.period || "30d";
    const orders = await listFinancialOrders(period);
    return ok(res, { orders });
  } catch (error) {
    return fail(res, error);
  }
});

router.post("/orders/:orderId/sync", async (req, res) => {
  try {
    const order = await syncOrderFinancialData(req.params.orderId);
    return ok(res, { order }, "Pedido sincronizado com sucesso.");
  } catch (error) {
    return fail(res, error, 400);
  }
});

/**
 * CATEGORIAS
 */
router.get("/categories", async (req, res) => {
  try {
    const type = req.query.type || "";
    const categories = await listFinancialCategories(type);
    return ok(res, { categories });
  } catch (error) {
    return fail(res, error);
  }
});

router.post("/categories", async (req, res) => {
  try {
    const category = await createFinancialCategory(req.body || {});
    return ok(res, { category }, "Categoria criada com sucesso.");
  } catch (error) {
    return fail(res, error, 400);
  }
});

router.patch("/categories/:id", async (req, res) => {
  try {
    const category = await updateFinancialCategory(req.params.id, req.body || {});
    return ok(res, { category }, "Categoria atualizada com sucesso.");
  } catch (error) {
    return fail(res, error, 400);
  }
});

/**
 * CONTAS A PAGAR
 * IMPORTANTE: mantive o nome accounts-payable
 * porque é exatamente o que seu frontend está chamando.
 */
router.get("/accounts-payable", async (req, res) => {
  try {
    const status = req.query.status || "";
    const items = await listAccountsPayable(status);
    return ok(res, { items });
  } catch (error) {
    return fail(res, error);
  }
});

router.post("/accounts-payable", async (req, res) => {
  try {
    const item = await createAccountPayable(req.body || {});
    return ok(res, { item }, "Conta a pagar criada com sucesso.");
  } catch (error) {
    return fail(res, error, 400);
  }
});

router.patch("/accounts-payable/:id", async (req, res) => {
  try {
    const item = await updateAccountPayable(req.params.id, req.body || {});
    return ok(res, { item }, "Conta a pagar atualizada com sucesso.");
  } catch (error) {
    return fail(res, error, 400);
  }
});

/**
 * CONTAS A RECEBER
 * IMPORTANTE: mantive o nome accounts-receivable
 * porque é exatamente o que seu frontend está chamando.
 */
router.get("/accounts-receivable", async (req, res) => {
  try {
    const status = req.query.status || "";
    const items = await listAccountsReceivable(status);
    return ok(res, { items });
  } catch (error) {
    return fail(res, error);
  }
});

router.post("/accounts-receivable", async (req, res) => {
  try {
    const item = await createAccountReceivable(req.body || {});
    return ok(res, { item }, "Conta a receber criada com sucesso.");
  } catch (error) {
    return fail(res, error, 400);
  }
});

router.patch("/accounts-receivable/:id", async (req, res) => {
  try {
    const item = await updateAccountReceivable(req.params.id, req.body || {});
    return ok(res, { item }, "Conta a receber atualizada com sucesso.");
  } catch (error) {
    return fail(res, error, 400);
  }
});

export default router;