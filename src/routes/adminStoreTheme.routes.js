import express from "express";
import { requireAdminAuth } from "../middlewares/auth.middleware.js";
import {
  createCustomPalette,
  deleteCustomPalette,
  getStoreThemeBundle,
  saveStoreTheme,
  updateCustomPalette,
} from "../services/storeTheme.service.js";

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
    message: error?.message || "Erro interno ao gerenciar tema da loja.",
    details: error?.data || null,
  });
}

router.get("/", async (req, res) => {
  try {
    const bundle = await getStoreThemeBundle();
    return ok(res, bundle);
  } catch (error) {
    console.error("ERRO AO BUSCAR TEMA DA LOJA:", error);
    return fail(res, error);
  }
});

router.put("/", async (req, res) => {
  try {
    const theme = await saveStoreTheme(req.body || {});
    return ok(res, { theme }, "Tema da loja salvo com sucesso.");
  } catch (error) {
    console.error("ERRO AO SALVAR TEMA DA LOJA:", error);
    return fail(res, error, error?.message ? 400 : 500);
  }
});

router.post("/palettes", async (req, res) => {
  try {
    const palette = await createCustomPalette(req.body || {});
    return ok(res, { palette }, "Paleta criada com sucesso.");
  } catch (error) {
    console.error("ERRO AO CRIAR PALETA:", error);
    return fail(res, error, 400);
  }
});

router.put("/palettes/:id", async (req, res) => {
  try {
    const palette = await updateCustomPalette(req.params.id, req.body || {});
    return ok(res, { palette }, "Paleta atualizada com sucesso.");
  } catch (error) {
    console.error("ERRO AO ATUALIZAR PALETA:", error);
    return fail(res, error, 400);
  }
});

router.delete("/palettes/:id", async (req, res) => {
  try {
    await deleteCustomPalette(req.params.id);
    return ok(res, {}, "Paleta excluída com sucesso.");
  } catch (error) {
    console.error("ERRO AO EXCLUIR PALETA:", error);
    return fail(res, error, 400);
  }
});

export default router;
