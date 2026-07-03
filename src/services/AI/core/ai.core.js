import { buildKnowledge } from "../knowledge/buildKnowledge.js";
import { decisionEngine } from "../decision/decision.engine.js";
import { executeActions } from "../actions/execute.actions.js";


export async function runAI({ contexts = [], message = "" }) {
  const knowledge = await buildKnowledge(contexts);

  // 1. gera sinais
  const signals = decisionEngine(knowledge);

  // 2. executa ações
  const actionsResult = await executeActions(signals, knowledge);

  return {
    success: true,
    message,
    knowledge,
    signals,
    actions: actionsResult,
    summary: {
      signals: signals.length,
      actions: actionsResult.length,
    },
  };
}