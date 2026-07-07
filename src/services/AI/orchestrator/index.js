import { buildKnowledge } from "../knowledge/buildKnowledge.js";
import { decisionEngine } from "../decision/decision.engine.js";
import { executeActions } from "../actions/execute.actions.js";
import { formatResponse, formatError } from "../core/response.core.js";
import { planIntent } from "../planner/index.js";
import { askDeepSeek } from "../providers/deepseek.provider.js";
import { getSystemPrompt } from "../prompts/system.prompt.js";

// AI Orchestrator (ponto central da execução)
// - Compatível com a arquitetura existente
// - FASE 1.2: Observabilidade/trace, steps e executionId
// - FASE 2.0: Chama LLM (DeepSeek) para gerar resposta textual

function createExecutionId(req) {
  const xReq = req?.headers?.["x-request-id"];
  if (xReq) return String(xReq);
  return `aios_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 8)}`;
}

function nowIso() {
  return new Date().toISOString();
}

export async function runOrchestrator({
  message = "",
  contexts = [],
  knowledge = null,
  user = null,
  req = null,
  history = [],
  executionId: executionIdExternal,
} = {}) {
  const executionId = executionIdExternal || createExecutionId(req);
  const traceStartedAt = Date.now();

  const steps = [];
  const pushStep = (step) => {
    steps.push(step);
  };

  const markStep = (stepId, patch) => {
    const s = steps.find((x) => x.stepId === stepId);
    if (!s) return;
    Object.assign(s, patch);
  };

  try {
    // Planner (apenas planeja). Não executa ações.
    const plannerStartedAt = Date.now();
    const plan = planIntent({ message, user });
    const plannerTime = Date.now() - plannerStartedAt;

    pushStep({
      stepId: "planner",
      agent: "planner",
      action: "plan_intent",
      status: "started",
      startedAt: nowIso(),
      finishedAt: null,
      duration: null,
      error: null,
    });
    markStep("planner", {
      status: "ok",
      finishedAt: nowIso(),
      duration: plannerTime,
      meta: { plannerVersion: plan?.version || "unknown" },
    });

    // Context Builder / Knowledge
    const knowledgeStepId = "build_knowledge";
    pushStep({
      stepId: knowledgeStepId,
      agent: "knowledge",
      action: "buildKnowledge",
      status: "started",
      startedAt: nowIso(),
      finishedAt: null,
      duration: null,
      error: null,
    });

    const knowledgeStartedAt = Date.now();
    const resolvedKnowledge =
      knowledge || (await buildKnowledge(Array.isArray(contexts) ? contexts : []));
    const knowledgeTime = Date.now() - knowledgeStartedAt;
    markStep(knowledgeStepId, {
      status: "ok",
      finishedAt: nowIso(),
      duration: knowledgeTime,
    });

    // Decision Engine
    const decisionStepId = "decision_engine";
    pushStep({
      stepId: decisionStepId,
      agent: "decision_engine",
      action: "decisionEngine",
      status: "started",
      startedAt: nowIso(),
      finishedAt: null,
      duration: null,
      error: null,
    });

    const decisionStartedAt = Date.now();
    const signals = decisionEngine(resolvedKnowledge, message);
    const decisionTime = Date.now() - decisionStartedAt;
    markStep(decisionStepId, {
      status: "ok",
      finishedAt: nowIso(),
      duration: decisionTime,
    });

    // Dispatcher + Registry + Tools + Repositories happens inside executeActions/agent layer today.
    const dispatchStepId = "dispatcher_actions";
    pushStep({
      stepId: dispatchStepId,
      agent: "dispatcher",
      action: "executeActions",
      status: "started",
      startedAt: nowIso(),
      finishedAt: null,
      duration: null,
      error: null,
    });

    const actionsStartedAt = Date.now();
    const actionsResult = await executeActions(signals, resolvedKnowledge);
    const actionsTime = Date.now() - actionsStartedAt;
    markStep(dispatchStepId, {
      status: "ok",
      finishedAt: nowIso(),
      duration: actionsTime,
    });

    // ============================================
    // FASE 2.0: Chamar LLM (DeepSeek) para gerar resposta textual
    // ============================================
    const llmStepId = "llm_generation";
    pushStep({
      stepId: llmStepId,
      agent: "deepseek",
      action: "askDeepSeek",
      status: "started",
      startedAt: nowIso(),
      finishedAt: null,
      duration: null,
      error: null,
    });

    const llmStartedAt = Date.now();

    // Monta system prompt com knowledge e contexts
    const systemPrompt = getSystemPrompt({
      knowledge: resolvedKnowledge,
      contexts,
    });

    // Adiciona resultados das actions ao contexto para a LLM
    const actionsSummary = Array.isArray(actionsResult) && actionsResult.length > 0
      ? `\n\nRESULTADOS DAS ACOES EXECUTADAS:\n${JSON.stringify(actionsResult, null, 2).slice(0, 4000)}`
      : "";

    const enrichedMessage = `${message}${actionsSummary}`;

    // Chama DeepSeek
    const llmResult = await askDeepSeek({
      message: enrichedMessage,
      history: Array.isArray(history) ? history : [],
      systemPrompt,
    });

    const llmTime = Date.now() - llmStartedAt;
    markStep(llmStepId, {
      status: llmResult?.success ? "ok" : "error",
      finishedAt: nowIso(),
      duration: llmTime,
      error: llmResult?.success ? null : (llmResult?.error?.message || "LLM error"),
    });

    // Usa a resposta da LLM, ou fallback se falhar
    const replyText = llmResult?.success && typeof llmResult?.reply === "string"
      ? llmResult.reply
      : "Processamento concluido, mas nao foi possivel gerar resposta textual.";

    const durationMs = Date.now() - traceStartedAt;

    return formatResponse({
      success: true,
      reply: replyText,
      data: {
        knowledge: resolvedKnowledge,
        signals,
      },
      actions: Array.isArray(actionsResult) ? actionsResult : [],
      metadata: {
        generatedAt: nowIso(),
        orchestrator: "v2_0",
        executionId,
        plannerTimeMs: plannerTime,
        orchestratorTimeMs: durationMs,
        llmTimeMs: llmTime,
        steps,
        summary: {
          signals: signals.length,
          actions: Array.isArray(actionsResult) ? actionsResult.length : 0,
          llmSuccess: llmResult?.success || false,
        },
      },
    });
  } catch (error) {
    const durationMs = Date.now() - traceStartedAt;

    // Marca a ultima etapa como erro se existir
    const last = steps.length ? steps[steps.length - 1] : null;
    if (last && last.status === "started") {
      last.status = "error";
      last.finishedAt = nowIso();
      last.duration = Date.now() - traceStartedAt;
      last.error = error?.message || String(error);
    }

    return formatError({
      message: error?.message,
      reply: "Erro no Orchestrator",
      metadata: {
        orchestrator: "v2_0",
        executionId,
        durationMs,
        steps,
        error: error?.message || String(error),
      },
    });
  }
}