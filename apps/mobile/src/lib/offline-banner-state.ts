import {
  type ConnectivityState,
  type ConnectivityStatus,
  connectivityStatus,
} from '@/lib/connectivity-online';

/** Wait out transient NetInfo reports before confirming offline with a probe. */
const OFFLINE_BANNER_SHOW_DELAY_MS = 5000;

/**
 * Fixed height of the offline banner row. The banner is an absolute overlay
 * pinned at `top: insets.top`, so a surface whose header starts at the
 * safe-area top must reserve this height while the banner is visible or the
 * overlay covers the header title (uxs2 spot check, e6-offline-hang; mobile-app
 * spot check, e2). `OfflineBanner` imports this constant and paints the row at
 * exactly this height (no vertical padding), and `ScreenHeader` reserves it via
 * `offlineHeaderReservation`, so the painted row and the reserved space cannot
 * drift. This is the single source of truth for that height.
 */
export const OFFLINE_BANNER_HEIGHT = 36;

/**
 * Top padding a pinned-header surface must reserve above its header for the
 * offline banner overlay: `OFFLINE_BANNER_HEIGHT` while the banner is visible,
 * 0 while online so the header keeps its natural position.
 */
export function offlineHeaderReservation(isOffline: boolean): number {
  return isOffline ? OFFLINE_BANNER_HEIGHT : 0;
}

export type OfflineBannerTimer = {
  set(callback: () => void, delayMs: number): { cancel(): void };
};

export type ConnectivitySource = {
  subscribe(listener: (state: ConnectivityState) => void): () => void;
};

export type OfflineBannerStore = {
  subscribe: (listener: () => void) => () => void;
  /**
   * Subscribes to `sourceStatus` changes. Kept separate from `subscribe` (the
   * committed banner state) so a surface that only reads committed state is not
   * woken by a source report the banner is still debouncing.
   */
  subscribeSourceStatus: (listener: () => void) => () => void;
  isOffline: () => boolean;
  state: () => BannerState;
  /**
   * The source's immediate classification, before the confirm-offline debounce
   * commits `state`. A definite `offline` here is a confirmed outage even while
   * `state` is still `unknown`, so a surface that settles a paused query can
   * react at once instead of waiting out `OFFLINE_BANNER_SHOW_DELAY_MS`.
   */
  sourceStatus: () => ConnectivityStatus;
  destroy: () => void;
};

/** The banner's committed connectivity state. */
export type BannerState = 'online' | 'offline' | 'unknown';

/** Wake every listener in a subscription set. */
function notifyListeners(recipients: ReadonlySet<() => void>): void {
  for (const listener of recipients) {
    listener();
  }
}

export function createOfflineBannerStore(options: {
  source: ConnectivitySource;
  timer: OfflineBannerTimer;
  probe: () => Promise<boolean>;
}): OfflineBannerStore {
  const { source, timer, probe } = options;

  // Start unknown: neither NetInfo nor a probe has confirmed connectivity yet.
  let state: BannerState = 'unknown';
  // NetInfo's latest classification, published immediately. Kept separate from
  // the debounced `state` so the banner can wait out transient reports while a
  // consumer that settles a paused query still sees a definite offline at once.
  let sourceStatus: ConnectivityStatus = 'unknown';
  let pending: { cancel(): void } | null = null;
  let generation = 0;
  let destroyed = false;
  // Committed-state subscribers (the banner and the tri-state hook).
  const listeners = new Set<() => void>();
  // Source-status subscribers (a paused-query gate that must react immediately).
  const sourceListeners = new Set<() => void>();

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
    notifyListeners(listeners);
  }

  function setSourceStatus(next: ConnectivityStatus): void {
    if (sourceStatus === next) {
      return;
    }
    sourceStatus = next;
    // Wake the source-status subscribers only. The banner is not woken: its
    // committed snapshot is unchanged while it debounces the report.
    notifyListeners(sourceListeners);
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
    setSourceStatus(status);
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

  const subscribeSourceStatus = (listener: () => void): (() => void) => {
    sourceListeners.add(listener);
    return () => {
      sourceListeners.delete(listener);
    };
  };

  const isOffline = (): boolean => state === 'offline';

  const getState = (): BannerState => state;

  const getSourceStatus = (): ConnectivityStatus => sourceStatus;

  const destroy = (): void => {
    destroyed = true;
    generation += 1;
    cancelPending();
    unsubscribeSource();
    listeners.clear();
    sourceListeners.clear();
  };

  return {
    subscribe,
    subscribeSourceStatus,
    isOffline,
    state: getState,
    sourceStatus: getSourceStatus,
    destroy,
  };
}
