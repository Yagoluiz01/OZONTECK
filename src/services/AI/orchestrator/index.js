import { buildKnowledge } from "../knowledge/buildKnowledge.js";
import { decisionEngine } from "../decision/decision.engine.js";
import { executeActions } from "../actions/execute.actions.js";
import { formatResponse, formatError } from "../core/response.core.js";
import { planIntent } from "../planner/index.js";
import { askDeepSeek } from "../providers/deepseek.provider.js";
import { getSystemPrompt } from "../prompts/system.prompt.js";
import { executeTools } from "../tools/execute.tools.js";

// AI Orchestrator (ponto central da execução)
// - Compatível com a arquitetura existente
// - FASE 1.2: Observabilidade/trace, steps e executionId
// - FASE 2.0: Chama LLM (DeepSeek) para gerar resposta textual
// - FASE 2.1: Executa ações de escrita com confirmação do usuário

function createExecutionId(req) {
  const xReq = req?.headers?.["x-request-id"];
  if (xReq) return String(xReq);
  return `aios_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 8)}`;
}

function nowIso() {
  return new Date().toISOString();
}

// ============================================
// Detecção de intenções de escrita (ações)
// ============================================

function detectWriteIntent(message) {
  const m = String(message || "").toLowerCase().trim();

  // Produtos
  if (/(criar|adicionar|cadastrar|novo)\s+(um\s+)?produto/i.test(m)) {
    return { tool: "products_write", operation: "create", entity: "product" };
  }
  if (/(atualizar|editar|alterar|modificar)\s+(o\s+)?produto/i.test(m)) {
    return { tool: "products_write", operation: "update", entity: "product" };
  }
  if (/(excluir|deletar|remover|apagar)\s+(o\s+)?produto/i.test(m)) {
    return { tool: "products_write", operation: "delete", entity: "product" };
  }

  // Afiliados
  if (/(criar|adicionar|cadastrar|novo)\s+(um\s+)?afiliado/i.test(m)) {
    return { tool: "affiliates_write", operation: "create", entity: "affiliate" };
  }
  if (/(atualizar|editar|alterar|modificar)\s+(o\s+)?afiliado/i.test(m)) {
    return { tool: "affiliates_write", operation: "update", entity: "affiliate" };
  }
  if (/(excluir|deletar|remover|apagar)\s+(o\s+)?afiliado/i.test(m)) {
    return { tool: "affiliates_write", operation: "delete", entity: "affiliate" };
  }

  // Pedidos
  if (/(atualizar|alterar|modificar| mudar)\s+(o\s+)?status\s+(do\s+)?pedido/i.test(m)) {
    return { tool: "orders_write", operation: "update_status", entity: "order" };
  }

  // Clientes
  if (/(criar|adicionar|cadastrar|novo)\s+(um\s+)?cliente/i.test(m)) {
    return { tool: "customers_write", operation: "create", entity: "customer" };
  }
  if (/(atualizar|editar|alterar|modificar)\s+(o\s+)?cliente/i.test(m)) {
    return { tool: "customers_write", operation: "update", entity: "customer" };
  }

  return null;
}

// Extrai parâmetros da mensagem usando a LLM
async function extractActionParameters({ message, intent, history, systemPrompt }) {
  const extractionPrompt = `Você é um extrator de parâmetros. Extraia os parâmetros da mensagem do usuário para a operação "${intent.operation}" de "${intent.entity}".

Mensagem: "${message}"

Responda APENAS com um JSON válido contendo os parâmetros extraídos. Não inclua texto adicional.

Exemplos:
- Para criar produto: {"name": "Perfume X", "price": 99.90, "stock": 10}
- Para atualizar produto: {"id": "123", "price": 89.90}
- Para criar afiliado: {"name": "João", "email": "joao@email.com", "phone": "11999999999"}
- Para atualizar status pedido: {"id": "123", "status": "shipped"}

Se não houver parâmetros suficientes, retorne: {"missing": true, "message": "Descrição do que falta"}`;

  const result = await askDeepSeek({
    message: extractionPrompt,
    history: [],
    systemPrompt: "Você é um extrator de parâmetros JSON.",
  });

  if (!result?.success) {
    return { missing: true, message: "Não foi possível extrair parâmetros." };
  }

  try {
    // Tenta parsear o JSON da resposta
    const jsonMatch = result.reply.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { missing: true, message: "Parâmetros não encontrados na resposta." };
    }
    return JSON.parse(jsonMatch[0]);
  } catch {
    return { missing: true, message: "Erro ao processar parâmetros." };
  }
}

export async function runOrchestrator({
  message = "",
  contexts = [],
  knowledge = null,
  user = null,
  req = null,
  history = [],
  executionId: executionIdExternal,
  confirmed = false,
  actionDetails = null,
  authToken = null,
  permissions = [],
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
    // ============================================
    // FASE 2.1: Detectar intenção de escrita
    // ============================================
    const writeIntent = detectWriteIntent(message);

    if (writeIntent && !confirmed) {
      // Detectou intenção de escrita mas não confirmada
      // Pede confirmação ao usuário
      const params = await extractActionParameters({
        message,
        intent: writeIntent,
        history,
        systemPrompt: getSystemPrompt({ knowledge: {}, contexts }),
      });

      if (params?.missing) {
        return formatResponse({
          success: true,
          reply: `Para ${writeIntent.operation} ${writeIntent.entity === "product" ? "o produto" : writeIntent.entity === "affiliate" ? "o afiliado" : writeIntent.entity === "order" ? "o pedido" : "o cliente"}, preciso de mais informações: ${params.message}`,
          data: { writeIntent, params },
          actions: [],
          metadata: {
            generatedAt: nowIso(),
            orchestrator: "v2_1",
            executionId,
            needsMoreInfo: true,
          },
        });
      }

      const entityLabel = {
        product: "produto",
        affiliate: "afiliado",
        order: "pedido",
        customer: "cliente",
      }[writeIntent.entity] || writeIntent.entity;

      const opLabel = {
        create: "criar",
        update: "atualizar",
        delete: "excluir",
        update_status: "atualizar status de",
      }[writeIntent.operation] || writeIntent.operation;

      const paramsSummary = Object.entries(params)
        .filter(([k]) => k !== "missing")
        .map(([k, v]) => `${k}: ${v}`)
        .join(", ");

      return formatResponse({
        success: true,
        reply: `Detectei que você quer ${opLabel} ${entityLabel}.\n\nParâmetros identificados: ${paramsSummary}\n\nPara executar esta ação, clique no botão "Confirmar ação" abaixo.`,
        data: {
          writeIntent,
          params,
        },
        actions: [],
        metadata: {
          generatedAt: nowIso(),
          orchestrator: "v2_1",
          executionId,
          action_required: true,
          action_details: {
            tool: writeIntent.tool,
            operation: writeIntent.operation,
            entity: writeIntent.entity,
            params,
          },
        },
      });
    }

    if (writeIntent && confirmed) {
      // Usuário confirmou - executar a tool
      const toolStepId = "tool_execution";
      pushStep({
        stepId: toolStepId,
        agent: "tool_executor",
        action: `execute_${writeIntent.tool}`,
        status: "started",
        startedAt: nowIso(),
        finishedAt: null,
        duration: null,
        error: null,
      });

      const toolStartedAt = Date.now();

      try {
        // Executa a tool
        const toolResult = await executeTools([{
          tool: writeIntent.tool,
          args: {
            permissions,
            reqMeta: { requestId: executionId },
            actor: user?.id || "ai_user",
            authToken,
            operation: {
              type: writeIntent.operation,
              payload: writeIntent.params || {},
              authToken,
            },
          },
        }]);

        const toolTime = Date.now() - toolStartedAt;
        markStep(toolStepId, {
          status: "ok",
          finishedAt: nowIso(),
          duration: toolTime,
        });

        const entityLabel = {
          product: "produto",
          affiliate: "afiliado",
          order: "pedido",
          customer: "cliente",
        }[writeIntent.entity] || writeIntent.entity;

        const opLabel = {
          create: "criado",
          update: "atualizado",
          delete: "excluído",
          update_status: "status atualizado",
        }[writeIntent.operation] || writeIntent.operation;

        return formatResponse({
          success: true,
          reply: `✅ ${entityLabel.charAt(0).toUpperCase() + entityLabel.slice(1)} ${opLabel} com sucesso!\n\nDetalhes: ${JSON.stringify(toolResult, null, 2).slice(0, 500)}`,
          data: { writeIntent, toolResult },
          actions: [toolResult],
          metadata: {
            generatedAt: nowIso(),
            orchestrator: "v2_1",
            executionId,
            action_executed: true,
            steps,
          },
        });
      } catch (toolError) {
        const toolTime = Date.now() - toolStartedAt;
        markStep(toolStepId, {
          status: "error",
          finishedAt: nowIso(),
          duration: toolTime,
          error: toolError?.message || String(toolError),
        });

        return formatResponse({
          success: false,
          reply: `❌ Erro ao executar ação: ${toolError?.message || "Erro desconhecido"}\n\nVerifique se você tem permissão para esta operação.`,
          data: { writeIntent, error: toolError?.message },
          actions: [],
          metadata: {
            generatedAt: nowIso(),
            orchestrator: "v2_1",
            executionId,
            action_failed: true,
            steps,
          },
        });
      }
    }

    // ============================================
    // Fluxo normal (leitura/análise)
    // ============================================

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
        orchestrator: "v2_1",
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
        orchestrator: "v2_1",
        executionId,
        durationMs,
        steps,
        error: error?.message || String(error),
      },
    });
  }
}