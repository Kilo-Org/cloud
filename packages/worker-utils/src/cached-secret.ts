const cache = new Map<string, Promise<string>>();

/**
 * Caches Cloudflare Secrets Store values for the lifetime of the Worker
 * isolate. Concurrent callers share the same in-flight Promise.
 */
export function getCachedSecret(
  binding: { get(): Promise<string | null> },
  name: string
): Promise<string> {
  let cached = cache.get(name);
  if (!cached) {
    cached = binding.get().then(s => {
      if (!s) throw new Error(`Secret '${name}' is not configured`);
      return s;
    });
    cache.set(name, cached);
  }
  return cached;
}
