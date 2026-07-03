import { buildAiContext } from "../services/ai/context/index.js";

export async function getAiContext(req, res) {
  try {
    const context = await buildAiContext();

    return res.json({
      success: true,
      context,
    });
  } catch (error) {
    console.error("[AI_CONTEXT]", error);

    return res.status(500).json({
      success: false,
      message: "Erro ao montar contexto da IA.",
    });
  }
}