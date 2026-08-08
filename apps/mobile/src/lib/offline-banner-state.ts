import { type ConnectivityState, isOnline } from '@/lib/connectivity-online';

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
  destroy: () => void;
};

export function createOfflineBannerStore(options: {
  source: ConnectivitySource;
  timer: OfflineBannerTimer;
  showDelayMs?: number;
}): OfflineBannerStore {
  const { source, timer } = options;
  const showDelayMs = options.showDelayMs ?? OFFLINE_BANNER_SHOW_DELAY_MS;

  let committedOnline = true;
  let pending: { cancel(): void } | null = null;
  const listeners = new Set<() => void>();

  function cancelPending(): void {
    pending?.cancel();
    pending = null;
  }

  function commit(online: boolean): void {
    committedOnline = online;
    for (const listener of listeners) {
      listener();
    }
  }

  function handleSourceState(state: ConnectivityState): void {
    const online = isOnline(state);
    cancelPending();
    if (online === committedOnline) {
      return;
    }
    if (online) {
      commit(true);
      return;
    }
    pending = timer.set(() => {
      pending = null;
      commit(false);
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

  const isOffline = (): boolean => !committedOnline;

  const destroy = (): void => {
    cancelPending();
    unsubscribeSource();
    listeners.clear();
  };

  return { subscribe, isOffline, destroy };
}
