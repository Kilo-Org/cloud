// Pure promise-sequencing helper, kept dependency-free so it can be
// vitest'd in node env without pulling in react-native/sonner transitively
// (same reasoning as session-list-cache.ts).

const inFlightSaves = new Map<string, Promise<unknown>>();

async function awaitSettled(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
  } catch {
    // Swallow — this is only used to sequence subsequent saves, not to
    // propagate the outcome (the caller of chainSave gets the real result).
  }
}

/**
 * Runs `run` only after the previous call for the same `key` has settled
 * (resolved or rejected), so concurrent saves for the same resource never
 * race. FIFO, no dedupe/coalescing — the caller sees the real
 * resolution/rejection of their own `run`, even when an earlier chained
 * save failed.
 */
export async function chainSave<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = inFlightSaves.get(key);
  if (previous) {
    await awaitSettled(previous);
  }
  const next = run();
  inFlightSaves.set(key, awaitSettled(next));
  return next;
}
