// Isolate-local TTL memoization for per-request lookups that change rarely
// (KV config, secrets-backed clients). Only a resolved value is cached: a
// pending load belongs to the request that started it, so a request that
// awaited another request's load would fail when that other request was
// cancelled. Rejected loads are not cached, so a transient failure is retried
// on the next request instead of being pinned for the TTL. `clear()` also
// discards a load that is still pending, and an older load never replaces a
// value whose load started later.
export type TtlCache<TEnv, T> = {
  get(env: TEnv): Promise<T>;
  clear(): void;
};

export function ttlCached<TEnv, T>(
  ttlMs: number,
  load: (env: TEnv) => Promise<T>
): TtlCache<TEnv, T> {
  let cached: { value: T; startedAt: number; expiresAt: number } | null = null;
  let generation = 0;

  return {
    async get(env: TEnv): Promise<T> {
      if (cached && cached.expiresAt > Date.now()) {
        return cached.value;
      }
      const gen = generation;
      const startedAt = Date.now();
      const value = await load(env);
      if (gen === generation && (cached === null || cached.startedAt <= startedAt)) {
        cached = { value, startedAt, expiresAt: startedAt + ttlMs };
      }
      return value;
    },
    clear(): void {
      generation += 1;
      cached = null;
    },
  };
}
