import { type ConnectivityState, connectivityStatus } from '@/lib/connectivity-online';

/**
 * How long the connection must stay down before the banner appears. NetInfo
 * reports a false `offline` for a moment after a long background, so a short
 * window flashed the banner on every foreground. Hiding stays immediate: a
 * banner that is up when the connection works is the worse error.
 */
export const OFFLINE_BANNER_SHOW_DELAY_MS = 5000;

export type OfflineBannerTimer = {
  set(callback: () => void, delayMs: number): { cancel(): void };
};

export type ConnectivitySource = {
  subscribe(listener: (state: ConnectivityState) => void): () => void;
};

export type OfflineBannerStore = {
  subscribe: (listener: () => void) => () => void;
  isOffline: () => boolean;
  state: () => BannerState;
  destroy: () => void;
};

/** The banner's committed connectivity state. */
export type BannerState = 'online' | 'offline' | 'unknown';

export function createOfflineBannerStore(options: {
  source: ConnectivitySource;
  timer: OfflineBannerTimer;
  showDelayMs?: number;
}): OfflineBannerStore {
  const { source, timer } = options;
  const showDelayMs = options.showDelayMs ?? OFFLINE_BANNER_SHOW_DELAY_MS;

  // Start unknown, not online: until NetInfo settles we cannot claim the
  // connection works, but we also must not show the offline banner.
  let state: BannerState = 'unknown';
  let pending: { cancel(): void } | null = null;
  const listeners = new Set<() => void>();

  function cancelPending(): void {
    pending?.cancel();
    pending = null;
  }

  function commit(next: BannerState): void {
    if (state === next) {
      return;
    }
    state = next;
    // Notify on every committed state change. The banner's `getSnapshot`
    // (`isOffline`) is unchanged on an unknown → online edge, so it does not
    // re-render there; the tri-state hook's `getSnapshot` (`state`) does.
    for (const listener of listeners) {
      listener();
    }
  }

  function handleSourceState(sourceState: ConnectivityState): void {
    const status = connectivityStatus(sourceState);
    cancelPending();
    if (status === 'unknown') {
      // Do not reveal the banner while connectivity is unknown, and do not
      // advance the committed state from its boot default.
      return;
    }
    if (status === 'online') {
      commit('online');
      return;
    }
    pending = timer.set(() => {
      pending = null;
      commit('offline');
    }, showDelayMs);
  }

  const unsubscribeSource = source.subscribe(handleSourceState);

  // Pre-bound closures: callers pass `subscribe` and `isOffline` as stable
  // references without losing `this` (they close over internal state).
  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const isOffline = (): boolean => state === 'offline';

  const getState = (): BannerState => state;

  const destroy = (): void => {
    cancelPending();
    unsubscribeSource();
    listeners.clear();
  };

  return { subscribe, isOffline, state: getState, destroy };
}
