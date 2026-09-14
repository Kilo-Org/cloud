import { type ConnectivityState, connectivityStatus } from '@/lib/connectivity-online';

/** Wait out transient NetInfo reports before confirming offline with a probe. */
const OFFLINE_BANNER_SHOW_DELAY_MS = 5000;

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
  probe: () => Promise<boolean>;
}): OfflineBannerStore {
  const { source, timer, probe } = options;

  // Start unknown: neither NetInfo nor a probe has confirmed connectivity yet.
  let state: BannerState = 'unknown';
  let pending: { cancel(): void } | null = null;
  let generation = 0;
  let destroyed = false;
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

  async function confirmConnectivity(attempt: number): Promise<void> {
    let reachable = false;
    try {
      reachable = await probe();
    } catch {
      // Synchronous throws and rejected probes both permit offline confirmation.
    }
    if (!destroyed && attempt === generation) {
      commit(reachable ? 'online' : 'offline');
    }
  }

  function handleSourceState(sourceState: ConnectivityState): void {
    generation += 1;
    const attempt = generation;
    cancelPending();
    if (destroyed) {
      return;
    }
    const status = connectivityStatus(sourceState);
    if (status === 'unknown') {
      // Unknown cancels confirmation but preserves the last committed state —
      // except committed-offline with the radio back up (e.g. airplane mode
      // switched to 3G while NetInfo's external reachability probe never
      // answers). Preserving offline there leaves the banner stale forever,
      // because no further event may ever arrive; the app's own probe (its
      // backend, not an external URL) is the decider instead (uxs3 spot
      // check, e6-after-net). A failed probe re-commits offline unchanged.
      if (state === 'offline' && sourceState.isConnected === true) {
        void confirmConnectivity(attempt);
      }
      return;
    }
    if (status === 'online') {
      commit('online');
      return;
    }
    pending = timer.set(() => {
      if (destroyed || attempt !== generation) {
        return;
      }
      pending = null;
      void confirmConnectivity(attempt);
    }, OFFLINE_BANNER_SHOW_DELAY_MS);
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
    destroyed = true;
    generation += 1;
    cancelPending();
    unsubscribeSource();
    listeners.clear();
  };

  return { subscribe, isOffline, state: getState, destroy };
}
