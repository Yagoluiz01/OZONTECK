import { formatError, formatResponse } from "../../AI/core/response.core.js";

// Prompt injection keywords/patterns (heurística defensiva)
const INJECTION_PATTERNS = [
  /ignore\s+all\s+instructions/i,
  /ignore\s+as\s+instru[cç][oõ]es/i,
  /reveal\s+your\s+prompt/i,
  /mostre\s+seu\s+prompt/i,
  /show\s+your\s+prompt/i,
  /api\s*-?key|api_key/i,
  /secret\b|secrets\b/i,
  /bearer\s+[a-z0-9\-\._]+/i,
  /token\b/i,
  /\.(env)\b|env\b/i,
  /mostre\s+as\s+chaves|mostre\s+tokens|mostre\s+vari[aá]veis/i,
  /desative\s+a\s+seguran[cç]a/i,
  /execute\s+any\s+command|execute\s+qualquer\s+comando/i,
  /sql\s*injection/i,
  /no\s*sql\s*injection/i,
  /drop\s+table|delete\s+from\s+/i,
];

function normalizeString(v) {
  return String(v ?? "");
}

function isInjection(text) {
  const t = normalizeString(text);
  return INJECTION_PATTERNS.some((r) => r.test(t));
}

function sanitizePlainText(text, { maxLen = 4000 } = {}) {
  const t = normalizeString(text);
  // Remove tentativa de payloads extremos
  const clipped = t.slice(0, maxLen);
  // Remove caracteres de controle comuns
  return clipped.replace(/[\u0000-\u001F\u007F]/g, " ").trim();
}

function validateRequest({ message, history }) {
  if (typeof message !== "string") {
    return {
      ok: false,
      error: formatError({
        reply: "Mensagem inválida.",
        metadata: { validation: "message_type" },
      }),
    };
  }

  if (!message.trim()) {
    return {
      ok: false,
      error: formatError({
        reply: "Mensagem não pode estar vazia.",
        metadata: { validation: "message_empty" },
      }),
    };
  }

  if (message.length > 4000) {
    return {
      ok: false,
      error: formatError({
        reply: "Mensagem muito longa.",
        metadata: { validation: "message_too_long" },
      }),
    };
  }

  if (history !== undefined && !Array.isArray(history)) {
    return {
      ok: false,
      error: formatError({
        reply: "Histórico inválido.",
        metadata: { validation: "history_type" },
      }),
    };
  }

  return { ok: true };
}

function buildExecutionId(req) {
  const xReqId = req?.headers?.["x-request-id"];
  if (xReqId) return String(xReqId);
  return `ai_exec_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 8)}`;
}

export function applyAiSecurityLayer({ req, message, history } = {}) {
  const executionId = buildExecutionId(req);

  const validated = validateRequest({ message, history });
  if (!validated.ok) {
    return {
      ok: false,
      executionId,
      response: validated.error,
    };
  }

  if (isInjection(message)) {
    return {
      ok: false,
      executionId,
      response: formatResponse({
        success: false,
        reply: "Solicitação bloqueada por segurança.",
        data: {},
        actions: [],
        metadata: {
          risk: "prompt_injection",
          executionId,
        },
      }),
    };
  }

  const sanitizedMessage = sanitizePlainText(message);

  return {
    ok: true,
    executionId,
    sanitized: {
      message: sanitizedMessage,
      history,
    },
    metadata: {
      risk: null,
      promptInjectionBlocked: false,
      executionId,
    },
  };
}

