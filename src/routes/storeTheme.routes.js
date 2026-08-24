import express from "express";
import { getPublicStoreThemeSnapshot } from "../services/storeTheme.service.js";

const router = express.Router();

router.get("/theme", async (req, res) => {
  try {
    const snapshot = await getPublicStoreThemeSnapshot();

    res.set(
      "Cache-Control",
      "public, max-age=60, s-maxage=300, stale-while-revalidate=900",
    );
    res.set("X-Ozonteck-Theme-Cache", snapshot.source);

    return res.status(200).json({
      success: true,
      ...snapshot.data,
    });
  } catch (error) {
    console.error("ERRO AO BUSCAR TEMA PÚBLICO DA LOJA:", error);
    res.set("Cache-Control", "no-store");

    return res.status(200).json({
      success: false,
      message: "Tema personalizado indisponível. Usando visual padrão da loja.",
      theme: null,
    });
  }
});

export default router;
