// Memory Engine (in-memory fallback)
// OBS: mantém a estrutura existente (não remove funcionalidades).
// Como o projeto atual não usa Redis/DB para memória, fornecemos
// um serviço seguro de fallback em memória para sessões concorrentes.

const store = new Map();

function ensureBucket(key) {
  if (!store.has(key)) {
    store.set(key, {
      history: [],
      last: {},
      errors: [],
      updatedAt: new Date().toISOString(),
    });
  }
  return store.get(key);
}

function normalizeLast(last) {
  return {
    lastSubject: last?.lastSubject ?? null,
    lastUser: last?.lastUser ?? null,
    lastProduct: last?.lastProduct ?? null,
    lastOrder: last?.lastOrder ?? null,
    lastReport: last?.lastReport ?? null,
    lastIntent: last?.lastIntent ?? null,
    lastActions: last?.lastActions ?? [],
    lastToolUsed: last?.lastToolUsed ?? null,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * @param {string} userId
 */
export function getMemory(userId) {
  const key = String(userId || "anonymous");
  return ensureBucket(key);
}

/**
 * @param {object} params
 */
export function appendMessage({ userId, role, content } = {}) {
  const bucket = getMemory(userId);

  const msg = {
    role: role === "assistant" ? "assistant" : "user",
    content: String(content || ""),
    createdAt: new Date().toISOString(),
  };

  bucket.history.push(msg);
  if (bucket.history.length > 50) bucket.history.shift();

  bucket.updatedAt = new Date().toISOString();
  return bucket;
}

export function setLast({ userId, last } = {}) {
  const bucket = getMemory(userId);
  bucket.last = normalizeLast(last);
  bucket.updatedAt = new Date().toISOString();
  return bucket;
}

export function addError({ userId, error } = {}) {
  const bucket = getMemory(userId);
  bucket.errors.push({
    message: error?.message || String(error || "unknown"),
    createdAt: new Date().toISOString(),
  });
  if (bucket.errors.length > 50) bucket.errors.shift();
  bucket.updatedAt = new Date().toISOString();
  return bucket;
}

export function clearMemory(userId) {
  const key = String(userId || "anonymous");
  store.delete(key);
}

