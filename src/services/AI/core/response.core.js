// Response Formatter (Response Core)
// Garante o contrato obrigatório em todas as saídas do agente.

export function formatResponse({
  success = true,
  reply,
  data = {},
  actions = [],
  metadata = {},
} = {}) {
  const safeReply =
    typeof reply === "string" && reply.trim().length > 0
      ? reply
      : "Sem resposta.";

  return {
    success: Boolean(success),
    reply: safeReply,
    data: data && typeof data === "object" ? data : {},
    actions: Array.isArray(actions) ? actions : [],
    metadata: metadata && typeof metadata === "object" ? metadata : {},
  };
}

export function formatError({
  message,
  reply,
  metadata,
} = {}) {
  return formatResponse({
    success: false,
    reply: typeof reply === "string" ? reply : message || "Erro interno",
    data: {},
    actions: [],
    metadata: {
      ...(metadata || {}),
      timestamp: new Date().toISOString(),
      error: true,
    },
  });
}

