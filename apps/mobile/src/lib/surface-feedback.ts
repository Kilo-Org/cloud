/**
 * One surface's last reported phase, as a single subscribable value.
 *
 * A surface (or one keyed item on a surface) is idle, pending, succeeded or
 * failed — never two at once, so a failure and an in-flight attempt can never
 * both be on screen. A failure is ONE object: its `kind`, the copy it renders
 * and the channel that announces it travel together, so a message cannot exist
 * without its kind and a view that renders `failure.message` cannot be handed a
 * failure that has none.
 *
 * `Failure` MUST carry a required `kind` discriminator, which is what lets a
 * renderer switch on `failure.kind` and prove the switch complete with
 * `assertSurfaceFailureHandled`.
 *
 * `succeeded` is kept because a surface may show a completed outcome that
 * persists. A surface whose success renders as its own new state (a cleared
 * field, fresh rows, a dismissed sheet) calls `attempt.abandon()` instead.
 *
 * `abandon()` removes the key's entry. `succeed()` and `fail()` keep it until
 * the next `begin()` for that key or until the surface unmounts; `clearWhere`
 * retires only a failure. A failure nothing on the surface renders (a toast
 * already reports it) settles with `abandon()`.
 */
export type SurfaceFailure = { readonly kind: string };

export type SurfaceFeedback<Failure extends SurfaceFailure> =
  | { readonly status: 'idle' }
  | { readonly status: 'pending' }
  | { readonly status: 'succeeded' }
  | { readonly status: 'failed'; readonly failure: Failure };

/**
 * One admitted attempt's right to publish. `begin` minted it; it publishes at
 * most once, and only while it still owns a pending entry.
 *
 * Each method returns whether this token was still the owner — `false` means a
 * newer attempt owns the key, or this one already settled. `false` is never a
 * signal to retry; the caller has nothing left to do with the result.
 */
export type SurfaceAttempt<Failure extends SurfaceFailure> = {
  succeed(): boolean;
  fail(failure: Failure): boolean;
  /** No outcome to publish: the entry goes away, the key reads `idle`. */
  abandon(): boolean;
  /**
   * Whether this token still owns its key's pending entry, without settling.
   * `false` means a newer attempt owns the key, the token already settled, or
   * the surface unmounted (`invalidateAll`). Callers that await before they
   * start work re-check this so a dismissed attempt writes nothing.
   */
  owns(): boolean;
};

/** The whole store as one subscribable value. */
export type SurfaceFeedbackSnapshot<Key extends string, Failure extends SurfaceFailure> = {
  /** Only non-idle phases are stored: a missing key reads as `idle`. */
  readonly states: ReadonlyMap<Key, SurfaceFeedback<Failure>>;
  /** Keys currently `pending`, in admission order. Derived, never stored. */
  readonly pendingKeys: readonly Key[];
};

type SurfaceFeedbackStore<Key extends string, Failure extends SurfaceFailure> = {
  /**
   * Admits an attempt synchronously and marks the key `pending`. Returns `null`
   * when the key is already pending: the caller MUST NOT start the work. This is
   * the family's one admission authority — do not add a second lock beside it.
   * Call it immediately before the first `await`.
   */
  begin: (key: Key) => SurfaceAttempt<Failure> | null;
  /**
   * Lifecycle removal: forgets the key (it reads `idle`) and makes every token
   * minted for it dead. Not for settling an attempt — an attempt settles itself.
   */
  reset: (key: Key) => void;
  /**
   * Retires the key's failure when `matches` accepts it, deleting the entry.
   * Only a `failed` phase is affected; a pending attempt keeps its admission.
   */
  clearWhere: (key: Key, matches: (failure: Failure) => boolean) => void;
  /** Forgets every key and kills every token. The adapter calls this on unmount. */
  invalidateAll: () => void;
  subscribe: (listener: () => void) => () => void;
  /** Same object until something changes, so it is safe for `useSyncExternalStore`. */
  getSnapshot: () => SurfaceFeedbackSnapshot<Key, Failure>;
};

/**
 * Proves a failure switch is complete. `noImplicitReturns` is off in this project
 * (`tsconfig.json`, `expo/tsconfig.base.json`), so an omitted `case` without this
 * call is NOT a compile error; calling this with the leftover value is. Use it as
 * the final statement of every `switch (failure.kind)`.
 */
export function assertSurfaceFailureHandled(failure: never): never {
  throw new Error(`Unhandled surface failure: ${JSON.stringify(failure)}`);
}

type StoredPhase<Failure extends SurfaceFailure> =
  | { readonly phase: 'pending'; readonly generation: number }
  | { readonly phase: 'succeeded'; readonly generation: number }
  | { readonly phase: 'failed'; readonly generation: number; readonly failure: Failure };

/**
 * The family's one store. Tokens come from one store-wide monotonic counter
 * whose values are never reused, so deleting an entry can never let an older
 * token authenticate against a later entry for the same key.
 */
export function createSurfaceFeedbackStore<
  Key extends string,
  Failure extends SurfaceFailure,
>(): SurfaceFeedbackStore<Key, Failure> {
  const entries = new Map<Key, StoredPhase<Failure>>();
  const listeners = new Set<() => void>();
  let nextGeneration = 0;
  let cached: SurfaceFeedbackSnapshot<Key, Failure> | null = null;

  function notify(): void {
    cached = null;
    // Copied so a listener may unsubscribe while the notification runs.
    for (const listener of listeners) {
      listener();
    }
  }

  function getSnapshot(): SurfaceFeedbackSnapshot<Key, Failure> {
    if (cached !== null) {
      return cached;
    }
    const states = new Map<Key, SurfaceFeedback<Failure>>();
    const pendingKeys: Key[] = [];
    for (const [key, entry] of entries) {
      if (entry.phase === 'pending') {
        states.set(key, { status: 'pending' });
        pendingKeys.push(key);
      } else if (entry.phase === 'succeeded') {
        states.set(key, { status: 'succeeded' });
      } else {
        states.set(key, { status: 'failed', failure: entry.failure });
      }
    }
    cached = { states, pendingKeys };
    return cached;
  }

  function begin(key: Key): SurfaceAttempt<Failure> | null {
    if (entries.get(key)?.phase === 'pending') {
      return null;
    }
    nextGeneration += 1;
    const generation = nextGeneration;
    // A settled entry is replaced, not overwritten in place: deleting it first
    // puts the new admission at the end of the map, so `pendingKeys` stays in
    // admission order after a re-admission.
    entries.delete(key);
    entries.set(key, { phase: 'pending', generation });
    notify();

    function owns(): boolean {
      const owned = entries.get(key);
      return owned?.phase === 'pending' && owned.generation === generation;
    }

    function settle(next: StoredPhase<Failure> | null): boolean {
      if (!owns()) {
        return false;
      }
      if (next === null) {
        entries.delete(key);
      } else {
        entries.set(key, next);
      }
      notify();
      return true;
    }

    return {
      succeed: () => settle({ phase: 'succeeded', generation }),
      fail: failure => settle({ phase: 'failed', generation, failure }),
      abandon: () => settle(null),
      owns,
    };
  }

  function reset(key: Key): void {
    if (entries.delete(key)) {
      notify();
    }
  }

  function clearWhere(key: Key, matches: (failure: Failure) => boolean): void {
    const current = entries.get(key);
    if (current?.phase !== 'failed' || !matches(current.failure)) {
      return;
    }
    entries.delete(key);
    notify();
  }

  function invalidateAll(): void {
    if (entries.size === 0) {
      return;
    }
    entries.clear();
    notify();
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  return { begin, reset, clearWhere, invalidateAll, subscribe, getSnapshot };
}
