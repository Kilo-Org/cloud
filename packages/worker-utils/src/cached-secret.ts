const resolved = new Map<string, string>();
let generation = 0;

/**
 * Caches Cloudflare Secrets Store values for the lifetime of the Worker
 * isolate. A name must map to exactly one binding per Worker. Only a resolved
 * value is stored: a pending read belongs to the request that started it, so a
 * request that awaited another request's read would fail when that other
 * request was cancelled. A failed read is not cached, so a transient fetch
 * failure doesn't poison the cache for the rest of the isolate's life.
 */
export async function getCachedSecret(
  binding: { get(): Promise<string | null> },
  name: string
): Promise<string> {
  const hit = resolved.get(name);
  if (hit !== undefined) return hit;

  const gen = generation;
  const secret = await binding.get();
  if (!secret) throw new Error(`Secret '${name}' is not configured`);
  if (gen === generation) resolved.set(name, secret);
  return secret;
}

/** Test-only: reset the cache between tests. */
export function clearSecretCacheForTest(): void {
  generation += 1;
  resolved.clear();
}
