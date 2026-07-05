import { buildKnowledge } from "../knowledge/buildKnowledge.js";
import { decisionEngine } from "../decision/decision.engine.js";
import { executeActions } from "../actions/execute.actions.js";
import { formatResponse, formatError } from "../core/response.core.js";
import { planIntent } from "../planner/index.js";

// AI Orchestrator (ponto central da execução)
// - Compatível com a arquitetura existente
// - FASE 1.2: Observabilidade/trace, steps e executionId

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
  // executionId externo (se existir). Se não existir, geramos aqui.
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
    // Para manter compatibilidade, medimos o bloco de execução de actions como etapa única.
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

    const durationMs = Date.now() - traceStartedAt;

    return formatResponse({
      success: true,
      reply: "Processamento concluído.",
      data: {
        knowledge: resolvedKnowledge,
        signals,
      },
      actions: Array.isArray(actionsResult) ? actionsResult : [],
      metadata: {
        generatedAt: nowIso(),
        orchestrator: "v1_1",
        executionId,
        plannerTimeMs: plannerTime,
        orchestratorTimeMs: durationMs,
        steps,
        summary: {
          signals: signals.length,
          actions: Array.isArray(actionsResult) ? actionsResult.length : 0,
        },
      },
    });
  } catch (error) {
    const durationMs = Date.now() - traceStartedAt;

    // Marca a última etapa como erro se existir
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
        orchestrator: "v1_1",
        executionId,
        durationMs,
        steps,
        error: error?.message || String(error),
      },
    });
  }
}


