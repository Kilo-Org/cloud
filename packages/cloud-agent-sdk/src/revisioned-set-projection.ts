/**
 * A read-only Set projection of one session's record, re-derived only when the
 * session or the caller's revision changes.
 *
 * The record is mutated in place — a live session predicate holds the same Set
 * — and jotai compares a derived value with `Object.is`. Returning the mutated
 * Set would leave its identity unchanged and notify no subscriber, so the
 * projection returns a fresh Set per revision: the identity stays stable
 * between bumps and a bump becomes observable.
 *
 * `read` is looked up on every derivation, never captured, so a projection can
 * be created before the record it reads exists.
 */
export function createRevisionedSetProjection<S extends string>(
  read: (sessionId: S) => ReadonlySet<string> | undefined,
  empty: ReadonlySet<string>
): (sessionId: S | null, revision: number) => ReadonlySet<string> {
  let cache: { sessionId: S; revision: number; value: ReadonlySet<string> } | null = null;
  return (sessionId, revision) => {
    if (sessionId === null) return empty;
    if (cache !== null && cache.sessionId === sessionId && cache.revision === revision) {
      return cache.value;
    }
    const recorded = read(sessionId);
    const value = recorded === undefined || recorded.size === 0 ? empty : new Set(recorded);
    cache = { sessionId, revision, value };
    return value;
  };
}
