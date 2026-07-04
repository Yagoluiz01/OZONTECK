import { runAI } from "./core/ai.core.js";

export async function sendAiMessage({
  message,
  history = [],
  user,
  promptContext,
} = {}) {
  // Segurança com LLM (sem liberar ações destrutivas):
  // - Sempre usamos apenas o contexto permitido (o agent/core faz o filtro)
  // - Aqui usamos DeepSeek para gerar texto de resposta (reply)
  // - Não executamos tools aqui; tool execution fica no agent (runAgent / agent.reports)

  if (!promptContext) {
    // fallback: texto simples via runAI (compatibilidade)
    return await runAI({ contexts: [], message });
  }

  // DeepSeek: monta prompt (systemPrompt) e usa o contexto como conteúdo.
  // Observação: `deepseek.provider` já faz o create() e retorna {success, reply}
  // O agente garante que promptContext só contenha dados permitidos.
  const { askDeepSeek } = await import("./providers/deepseek.provider.js");
  const systemPrompt = promptContext?.base?.systemPrompt || "Você é um assistente de negócios.";

  const replyText = await askDeepSeek({
    message,
    history,
    systemPrompt,
  });

  return {
    success: true,
    reply: replyText?.reply || "Sem resposta.",
    note: "AI modo seguro com LLM (DeepSeek).",
    promptContextSummary: {
      allowedContexts: promptContext?.allowedContexts?.length || 0,
    },
  };
}
