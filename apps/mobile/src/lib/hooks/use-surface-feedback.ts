/**
 * React adapters over one `createSurfaceFeedbackStore` instance per mount.
 *
 * The phase lives in the store, never in `useState` mirrors: a view renders the
 * subscribed snapshot, so a stale rejection cannot render under a newer submit.
 * The store's method identities are stable, so `begin`/`clearWhere` may be
 * listed in a consumer's dependency array.
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

import {
  createSurfaceFeedbackStore,
  type SurfaceAttempt,
  type SurfaceFailure,
  type SurfaceFeedback,
  type SurfaceFeedbackSnapshot,
} from '@/lib/surface-feedback';

type SurfaceFeedbackController<Failure extends SurfaceFailure> = {
  readonly feedback: SurfaceFeedback<Failure>;
  /** The failure to render, or `null`. The same object `feedback` holds. */
  readonly failure: Failure | null;
  /** Stable identity: safe as a `useCallback` dependency. */
  readonly begin: () => SurfaceAttempt<Failure> | null;
  /** Stable identity. Retires a failure the surface still shows; never touches pending. */
  readonly clearWhere: (matches: (failure: Failure) => boolean) => void;
};

type KeyedSurfaceFeedbackController<Key extends string, Failure extends SurfaceFailure> = {
  readonly snapshot: SurfaceFeedbackSnapshot<Key, Failure>;
  readonly begin: (key: Key) => SurfaceAttempt<Failure> | null;
  readonly clearWhere: (key: Key, matches: (failure: Failure) => boolean) => void;
};

const IDLE_DEFAULT: SurfaceFeedback<never> = { status: 'idle' };
const DEFAULT_KEY = 'default';

/** One keyed phase per item on a surface, for surfaces that act on many items at once. */
export function useKeyedSurfaceFeedback<
  Key extends string,
  Failure extends SurfaceFailure,
>(): KeyedSurfaceFeedbackController<Key, Failure> {
  const [store] = useState(() => createSurfaceFeedbackStore<Key, Failure>());
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  // A departed surface's tokens are dead even though its async work continues.
  useEffect(
    () => () => {
      store.invalidateAll();
    },
    [store]
  );
  const begin = useCallback((key: Key) => store.begin(key), [store]);
  const clearWhere = useCallback(
    (key: Key, matches: (failure: Failure) => boolean) => {
      store.clearWhere(key, matches);
    },
    [store]
  );
  return { snapshot, begin, clearWhere };
}

export function useSurfaceFeedback<
  Failure extends SurfaceFailure,
>(): SurfaceFeedbackController<Failure> {
  const {
    snapshot,
    begin: beginKeyed,
    clearWhere: clearWhereKeyed,
  } = useKeyedSurfaceFeedback<typeof DEFAULT_KEY, Failure>();
  const feedback: SurfaceFeedback<Failure> = snapshot.states.get(DEFAULT_KEY) ?? IDLE_DEFAULT;
  const begin = useCallback(() => beginKeyed(DEFAULT_KEY), [beginKeyed]);
  const clearWhere = useCallback(
    (matches: (failure: Failure) => boolean) => {
      clearWhereKeyed(DEFAULT_KEY, matches);
    },
    [clearWhereKeyed]
  );
  return {
    feedback,
    failure: feedback.status === 'failed' ? feedback.failure : null,
    begin,
    clearWhere,
  };
}
