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
 * save failed. The tail is registered synchronously (before any await) so
 * back-to-back callers each chain behind the correct predecessor, and each
 * key is dropped from the map once its own tail settles.
 */
// eslint-disable-next-line typescript-eslint/require-await -- the awaits live inside the nested IIFEs so the tail is registered synchronously; see the doc comment above
export async function chainSave<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = inFlightSaves.get(key);
  const next = (async () => {
    if (previous) {
      await awaitSettled(previous);
    }
    return run();
  })();
  // eslint-disable-next-line eslint-plugin-promise/prefer-await-to-then -- tail must reference its own settled promise for the cleanup guard below; wrapping this in an awaited helper reintroduces the pre-await `set` this fix removes
  const tail: Promise<void> = awaitSettled(next).finally(() => {
    if (inFlightSaves.get(key) === tail) {
      inFlightSaves.delete(key);
    }
  });
  inFlightSaves.set(key, tail);
  return next;
}

// Test-only: exposes the internal map size so tests can assert keys are
// released once their chain settles, without reaching into module internals.
export function inFlightSaveCount(): number {
  return inFlightSaves.size;
}
