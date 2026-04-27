const store = new Map();

export function memo(key, ttlMs, fn) {
  const hit = store.get(key);
  const now = Date.now();
  if (hit && hit.expires > now) return Promise.resolve(hit.value);
  return Promise.resolve(fn()).then(value => {
    store.set(key, { value, expires: now + ttlMs });
    return value;
  });
}

export function invalidate(prefix) {
  for (const k of store.keys()) if (k.startsWith(prefix)) store.delete(k);
}
