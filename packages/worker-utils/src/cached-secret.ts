const cache = new WeakMap<object, Promise<string>>();

/**
 * Caches Cloudflare Secrets Store values for the lifetime of the Worker
 * isolate. Keyed by the binding object itself — the same binding returns
 * the same cached value, while different bindings (or test mocks) get
 * independent entries. Concurrent callers share the same in-flight Promise.
 */
export function getCachedSecret(
  binding: { get(): Promise<string | null> },
  name: string
): Promise<string> {
  let cached = cache.get(binding);
  if (!cached) {
    cached = binding.get().then(s => {
      if (!s) throw new Error(`Secret '${name}' is not configured`);
      return s;
    });
    cache.set(binding, cached);
  }
  return cached;
}
