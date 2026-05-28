import express from "express";
import { getPublicStoreTheme } from "../services/storeTheme.service.js";

const router = express.Router();

router.get("/theme", async (req, res) => {
  try {
    const data = await getPublicStoreTheme();

    return res.status(200).json({
      success: true,
      ...data,
    });
  } catch (error) {
    console.error("ERRO AO BUSCAR TEMA PÚBLICO DA LOJA:", error);

    return res.status(200).json({
      success: false,
      message: "Tema personalizado indisponível. Usando visual padrão da loja.",
      theme: null,
    });
  }
});

export default router;
