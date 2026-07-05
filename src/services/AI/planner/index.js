import { formatError, formatResponse } from "../core/response.core.js";

// Planner v1 (compatível)
// Nesta Fase 1 o planner gera um plano determinístico a partir do message
// sem alterar o comportamento existente (runAgent/runAI continuam). 

function normalizeMessage(message) {
  return String(message || "").trim();
}

function detectPlanModules(message) {
  const m = normalizeMessage(message).toLowerCase();
  const modules = new Set();

  if (m.includes("produto") || m.includes("produtos") || m.includes("estoque")) modules.add("products");
  if (m.includes("pedido") || m.includes("pedidos")) modules.add("orders");
  if (m.includes("cliente") || m.includes("clientes")) modules.add("customers");
  if (m.includes("financeiro") || m.includes("faturamento") || m.includes("caixa")) modules.add("financial");
  if (m.includes("afiliado") || m.includes("afiliados")) modules.add("affiliates");
  if (m.includes("lead") || m.includes("leads")) modules.add("leads");
  if (m.includes("dashboard") || m.includes("painel")) modules.add("dashboard");

  // Sempre retorna ao menos um módulo "dashboard" como fallback neutro.
  if (modules.size === 0) modules.add("dashboard");

  return Array.from(modules);
}

export function planIntent({ message = "", user = null } = {}) {
  const text = normalizeMessage(message);
  const modules = detectPlanModules(text);

  // Plano v1: não executa ações; apenas descreve etapas.
  return {
    version: "planner_v1",
    modules,
    steps: [
      {
        id: "step_1_build_context",
        type: "build_context",
        owner: "planner",
        status: "ready",
      },
      {
        id: "step_2_decide",
        type: "decision_engine",
        owner: "planner",
        status: "ready",
        modules,
      },
      {
        id: "step_3_dispatch",
        type: "dispatcher",
        owner: "planner",
        status: "ready",
      },
    ],
    user,
  };
}

export async function runPlanner({ message = "", user = null } = {}) {
  try {
    const plan = planIntent({ message, user });
    return formatResponse({
      success: true,
      reply: "Plano gerado.",
      data: { plan },
      actions: [],
      metadata: { planner: plan.version },
    });
  } catch (error) {
    return formatError({
      message: error?.message,
      reply: "Falha no planner",
      metadata: { planner: "planner_v1" },
    });
  }
}

