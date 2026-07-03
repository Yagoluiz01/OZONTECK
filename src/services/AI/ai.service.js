import { runAI } from "./core/ai.core.js";

export async function sendAiMessage({
  message,
  history = [],
  user,
  promptContext,
} = {}) {
  // Nesta fase (Fase 1: agente consulta/relatórios), não chamamos LLM.
  // Mantemos comportamento determinístico e seguro.
  // Se no futuro quiser usar LLM, aqui é o único lugar.
  if (!promptContext) {
    // fallback: usa o runAI existente para manter compatibilidade
    return await runAI({ contexts: [], message });
  }

  return {
    success: true,
    message,
    promptContext,
    user: user ? { id: user.id, role: user.role } : null,
    note: "AI em modo seguro (Fase 1).",
  };
}
