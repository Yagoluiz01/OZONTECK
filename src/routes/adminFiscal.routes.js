import express from "express";
import { requireAdminAuth } from "../middlewares/auth.middleware.js";
import {
  getFiscalSummary,
  listFiscalObligations,
  createFiscalObligation,
  updateFiscalObligation,
  listAffiliateFiscalRecords,
  listInvoiceRecords,
  getFiscalSettings,
  updateFiscalSettings,
} from "../services/adminFiscal.service.js";

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

router.get("/summary", async (req, res) => {
  try {
    const summary = await getFiscalSummary(req.query.competence || "");
    return ok(res, { summary });
  } catch (error) {
    return fail(res, error);
  }
});

router.get("/obligations", async (req, res) => {
  try {
    const obligations = await listFiscalObligations(req.query.competence || "");
    return ok(res, { obligations });
  } catch (error) {
    return fail(res, error);
  }
});

router.post("/obligations", async (req, res) => {
  try {
    const obligation = await createFiscalObligation(req.body || {});
    return ok(res, { obligation }, "Obrigação fiscal criada com sucesso.");
  } catch (error) {
    return fail(res, error, 400);
  }
});

router.patch("/obligations/:id", async (req, res) => {
  try {
    const obligation = await updateFiscalObligation(req.params.id, req.body || {});
    return ok(res, { obligation }, "Obrigação fiscal atualizada com sucesso.");
  } catch (error) {
    return fail(res, error, 400);
  }
});

router.get("/affiliates", async (req, res) => {
  try {
    const affiliates = await listAffiliateFiscalRecords(req.query.competence || "");
    return ok(res, { affiliates });
  } catch (error) {
    return fail(res, error);
  }
});

router.get("/invoices", async (req, res) => {
  try {
    const invoices = await listInvoiceRecords(req.query.competence || "");
    return ok(res, { invoices });
  } catch (error) {
    return fail(res, error);
  }
});

router.get("/settings", async (req, res) => {
  try {
    const settings = await getFiscalSettings();
    return ok(res, { settings });
  } catch (error) {
    return fail(res, error);
  }
});

router.patch("/settings", async (req, res) => {
  try {
    const settings = await updateFiscalSettings(req.body || {});
    return ok(res, { settings }, "Configurações fiscais atualizadas com sucesso.");
  } catch (error) {
    return fail(res, error, 400);
  }
});

export default router;
