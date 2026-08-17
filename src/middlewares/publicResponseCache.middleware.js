const CACHE_RULES = new Map([
  ["/api/store/categories/active", 60_000],
  ["/api/store/marketing/pixels", 60_000],
]);

const cache = new Map();
const inFlight = new Map();

function cloneJson(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

function getCacheKey(req) {
  if (String(req.method || "").toUpperCase() !== "GET") return null;
  const path = String(req.path || String(req.originalUrl || "").split("?")[0] || "");
  return CACHE_RULES.has(path) ? path : null;
}

function getFreshEntry(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  return entry;
}

function sendEntry(res, entry, state = "HIT") {
  res.setHeader("X-OZ-Response-Cache", state);
  return res.status(entry.statusCode).json(cloneJson(entry.body));
}

export async function publicResponseCacheMiddleware(req, res, next) {
  const key = getCacheKey(req);
  if (!key) return next();

  const fresh = getFreshEntry(key);
  if (fresh) return sendEntry(res, fresh);

  const pending = inFlight.get(key);
  if (pending) {
    try {
      await pending;
      const coalesced = getFreshEntry(key);
      if (coalesced) return sendEntry(res, coalesced, "COALESCED");
    } catch {
      // Se a requisição líder falhar, a rota normal continua disponível.
    }
    return next();
  }

  let settle;
  const leaderDone = new Promise((resolve) => {
    settle = resolve;
  });
  inFlight.set(key, leaderDone);

  const originalJson = res.json.bind(res);
  let captured = false;

  res.json = (body) => {
    if (!captured && res.statusCode >= 200 && res.statusCode < 300) {
      captured = true;
      const ttlMs = CACHE_RULES.get(key) || 0;
      cache.set(key, {
        statusCode: res.statusCode,
        body: cloneJson(body),
        expiresAt: Date.now() + ttlMs,
      });
      res.setHeader("X-OZ-Response-Cache", "MISS");
    }
    return originalJson(body);
  };

  const finish = () => {
    if (inFlight.get(key) === leaderDone) inFlight.delete(key);
    settle();
  };

  res.once("finish", finish);
  res.once("close", finish);
  return next();
}

export function clearPublicResponseCache(path = null) {
  if (path) cache.delete(String(path));
  else cache.clear();
}
