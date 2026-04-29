const resolved = new Map<string, string>();
const inflight = new Map<string, Promise<string>>();

/**
 * Caches Cloudflare Secrets Store values for the lifetime of the Worker
 * isolate. Concurrent callers share an in-flight Promise; only resolved
 * values are persisted, so a transient fetch failure doesn't poison the
 * cache for the rest of the isolate's life.
 */
export function getCachedSecret(
  binding: { get(): Promise<string | null> },
  name: string
): Promise<string> {
  const hit = resolved.get(name);
  if (hit !== undefined) return Promise.resolve(hit);

  const inflightHit = inflight.get(name);
  if (inflightHit) return inflightHit;

  const promise = binding
    .get()
    .then(s => {
      if (!s) throw new Error(`Secret '${name}' is not configured`);
      resolved.set(name, s);
      return s;
    })
    .finally(() => {
      inflight.delete(name);
    });

  inflight.set(name, promise);
  return promise;
}

/** Test-only: reset the cache between tests. */
export function clearSecretCacheForTest(): void {
  resolved.clear();
  inflight.clear();
}
