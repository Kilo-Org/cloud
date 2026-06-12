// Isolate-local TTL memoization for per-request lookups that change rarely
// (KV config, secrets-backed clients). Values are cached as promises so
// concurrent callers share one load; rejected loads are evicted immediately
// so a transient failure is not pinned for the TTL.
export type TtlCache<TEnv, T> = {
  get(env: TEnv): Promise<T>;
  clear(): void;
};

export function ttlCached<TEnv, T>(
  ttlMs: number,
  load: (env: TEnv) => Promise<T>
): TtlCache<TEnv, T> {
  let cached: { promise: Promise<T>; expiresAt: number } | null = null;

  return {
    get(env: TEnv): Promise<T> {
      if (cached && cached.expiresAt > Date.now()) {
        return cached.promise;
      }
      const promise = load(env);
      const entry = { promise, expiresAt: Date.now() + ttlMs };
      cached = entry;
      promise.catch(() => {
        if (cached === entry) {
          cached = null;
        }
      });
      return promise;
    },
    clear(): void {
      cached = null;
    },
  };
}
