import express from "express";
import multer from "multer";
import { requireAdminAuth } from "../middlewares/auth.middleware.js";
import {
  listAffiliates,
  listAffiliateSummary,
  getAffiliateById,
  createAffiliate,
  updateAffiliate,
  listAffiliateConversions,
  listAffiliatePayouts,
  createAffiliatePayout,
  listAffiliateApplications,
  approveAffiliateApplication,
  rejectAffiliateApplication,
} from "../services/adminAffiliates.service.js";

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 8 * 1024 * 1024,
  },
});

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

/**
 * SOLICITAÇÕES DE AFILIADOS
 */
router.get("/applications", async (req, res) => {
  try {
    const applications = await listAffiliateApplications(req.query || {});
    return ok(res, { applications });
  } catch (error) {
    return fail(res, error);
  }
});

router.post("/applications/:id/approve", async (req, res) => {
  try {
    const result = await approveAffiliateApplication(req.params.id, req.body || {});

    return ok(
      res,
      result,
      "Solicitação aprovada e afiliado criado com sucesso."
    );
  } catch (error) {
    return fail(res, error, 400);
  }
});

router.post("/applications/:id/reject", async (req, res) => {
  try {
    const application = await rejectAffiliateApplication(
      req.params.id,
      req.body || {}
    );

    return ok(
      res,
      { application },
      "Solicitação de afiliado rejeitada com sucesso."
    );
  } catch (error) {
    return fail(res, error, 400);
  }
});

/**
 * RESUMO DOS AFILIADOS
 */
router.get("/summary", async (req, res) => {
  try {
    const affiliates = await listAffiliateSummary(req.query || {});
    return ok(res, { affiliates });
  } catch (error) {
    return fail(res, error);
  }
});

/**
 * LISTAR AFILIADOS
 */
router.get("/", async (req, res) => {
  try {
    const affiliates = await listAffiliates(req.query || {});
    return ok(res, { affiliates });
  } catch (error) {
    return fail(res, error);
  }
});

/**
 * BUSCAR AFILIADO POR ID
 */
router.get("/:id", async (req, res) => {
  try {
    const affiliate = await getAffiliateById(req.params.id);

    if (!affiliate) {
      return fail(res, new Error("Afiliado não encontrado."), 404);
    }

    return ok(res, { affiliate });
  } catch (error) {
    return fail(res, error);
  }
});

/**
 * CRIAR AFILIADO
 */
router.post("/", async (req, res) => {
  try {
    const affiliate = await createAffiliate(req.body || {});
    return ok(res, { affiliate }, "Afiliado criado com sucesso.");
  } catch (error) {
    return fail(res, error, 400);
  }
});

/**
 * ATUALIZAR AFILIADO
 */
router.patch("/:id", async (req, res) => {
  try {
    const affiliate = await updateAffiliate(req.params.id, req.body || {});

    if (!affiliate) {
      return fail(res, new Error("Afiliado não encontrado."), 404);
    }

    return ok(res, { affiliate }, "Afiliado atualizado com sucesso.");
  } catch (error) {
    return fail(res, error, 400);
  }
});

/**
 * CONVERSÕES / COMISSÕES
 */
router.get("/:id/conversions", async (req, res) => {
  try {
    const conversions = await listAffiliateConversions({
      affiliate_id: req.params.id,
      status: req.query.status || "",
    });

    return ok(res, { conversions });
  } catch (error) {
    return fail(res, error);
  }
});

/**
 * PAGAMENTOS
 */
router.get("/:id/payouts", async (req, res) => {
  try {
    const payouts = await listAffiliatePayouts({
      affiliate_id: req.params.id,
      status: req.query.status || "",
    });

    return ok(res, { payouts });
  } catch (error) {
    return fail(res, error);
  }
});

/**
 * REGISTRAR PAGAMENTO COM COMPROVANTE
 */
router.post("/:id/payouts", upload.single("receipt"), async (req, res) => {
  try {
    const payout = await createAffiliatePayout({
      ...(req.body || {}),
      affiliate_id: req.params.id,
      receiptFile: req.file || null,
    });

    return ok(res, { payout }, "Pagamento de comissão registrado com sucesso.");
  } catch (error) {
    return fail(res, error, 400);
  }
});

export default router;