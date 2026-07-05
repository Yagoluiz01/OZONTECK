import { buildKnowledge } from "../knowledge/buildKnowledge.js";
import { decisionEngine } from "../decision/decision.engine.js";
import { executeActions } from "../actions/execute.actions.js";


export async function runAI({ contexts = [], message = "", reply = "" } = {}) {
  const knowledge = await buildKnowledge(contexts);

  // 1) Sinais (automações) 
  const signals = decisionEngine(knowledge, message);

  // 2) Ações (handlers) 
  const actionsResult = await executeActions(signals, knowledge);

  // 3) Resposta textual (sem LLM aqui; agent/core pode sobrescrever)
  const replyText =
    typeof reply === "string" && reply.trim().length > 0
      ? reply
      : "Processamento concluído.";

  return {
    success: true,
    reply: replyText,
    data: {
      knowledge,
      signals,
    },
    actions: Array.isArray(actionsResult) ? actionsResult : [],
    metadata: {
      summary: {
        signals: signals.length,
        actions: Array.isArray(actionsResult) ? actionsResult.length : 0,
      },
      generatedAt: new Date().toISOString(),
    },
  };
}
