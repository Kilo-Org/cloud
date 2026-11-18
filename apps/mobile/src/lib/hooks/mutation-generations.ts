// Pure per-key generation counter, kept dependency-free so it can be
// vitest'd in node env without pulling in react-native transitively
// (same reasoning as save-chain.ts).

const generations = new Map<string, number>();

/**
 * Increments and returns the per-key generation counter. Call this in a
 * mutation's `onMutate` to stamp the optimistic write it is about to make.
 */
export function nextMutationGeneration(key: string): number {
  const next = (generations.get(key) ?? 0) + 1;
  generations.set(key, next);
  return next;
}

/**
 * True when the per-key counter still equals `generation`, i.e. no newer
 * mutation has stamped the same cache since. An older mutation's failure
 * must not roll back cache state a newer mutation already owns; the newer
 * mutation's settle-time invalidation reconciles with server truth.
 * Accepted residual: when both fail, the older optimistic value can show
 * until the settle invalidation refetches.
 */
export function isLatestMutationGeneration(key: string, generation: number): boolean {
  return generations.get(key) === generation;
}
