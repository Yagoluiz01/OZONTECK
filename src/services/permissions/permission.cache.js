const DEFAULT_TTL_MS = 60_000;

const cache = new Map();

function now() {
  return Date.now();
}

function makeKey(adminId) {
  return String(adminId || "").trim();
}

export function getCachedAdminPermissionSet(adminId) {
  const key = makeKey(adminId);
  if (!key) return null;

  const entry = cache.get(key);
  if (!entry) return null;

  if (entry.expiresAt <= now()) {
    cache.delete(key);
    return null;
  }

  return entry.value || null;
}

export function setCachedAdminPermissionSet(adminId, value, ttlMs = DEFAULT_TTL_MS) {
  const key = makeKey(adminId);
  if (!key) return;

  cache.set(key, {
    value: value || null,
    expiresAt: now() + Math.max(1_000, Number(ttlMs) || DEFAULT_TTL_MS),
  });
}

export function invalidateAdminPermissionCache(adminId) {
  const key = makeKey(adminId);
  if (!key) return;
  cache.delete(key);
}

export function clearPermissionCache() {
  cache.clear();
}
