import { type ConnectivityState, isOnline } from '@/lib/connectivity-online';

export const OFFLINE_BANNER_DEBOUNCE_MS = 1000;

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
  debounceMs?: number;
}): OfflineBannerStore {
  const { source, timer } = options;
  const debounceMs = options.debounceMs ?? OFFLINE_BANNER_DEBOUNCE_MS;

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

  function schedule(online: boolean): void {
    cancelPending();
    pending = timer.set(() => {
      pending = null;
      commit(online);
    }, debounceMs);
  }

  function handleSourceState(state: ConnectivityState): void {
    const online = isOnline(state);
    if (online === committedOnline) {
      cancelPending();
      return;
    }
    schedule(online);
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
