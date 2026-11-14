import { type ConnectivityState, connectivityStatus } from '@/lib/connectivity-online';

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
  isOffline: () => boolean;
  state: () => BannerState;
  /** The phase behind the painted state, for the write gates. */
  phase: () => ConnectivityPhase;
  destroy: () => void;
};

/** The banner's committed connectivity state. */
export type BannerState = 'online' | 'offline' | 'unknown';

/**
 * What the app knows about connectivity. `confirming-offline` is the window in which a
 * disconnect report is being checked by the app's own probe; it is not evidence of a
 * working transport, so a write is refused in it exactly as when confirmed offline, and
 * it keeps painting the state it replaced.
 */
export type ConnectivityPhase =
  | { readonly kind: 'unknown' }
  | { readonly kind: 'online' }
  | { readonly kind: 'offline' }
  | { readonly kind: 'confirming-offline'; readonly previous: BannerState };

/** The banner state a phase shows. */
export function projectBannerState(phase: ConnectivityPhase): BannerState {
  return phase.kind === 'confirming-offline' ? phase.previous : phase.kind;
}

/** True while a network write cannot complete: confirmed or being confirmed offline. */
export function phaseBlocksWrites(phase: ConnectivityPhase): boolean {
  return phase.kind === 'offline' || phase.kind === 'confirming-offline';
}

export function createOfflineBannerStore(options: {
  source: ConnectivitySource;
  timer: OfflineBannerTimer;
  probe: () => Promise<boolean>;
}): OfflineBannerStore {
  const { source, timer, probe } = options;

  // Start unknown: neither NetInfo nor a probe has confirmed connectivity yet.
  let phase: ConnectivityPhase = { kind: 'unknown' };
  let pending: { cancel(): void } | null = null;
  let generation = 0;
  let destroyed = false;
  const listeners = new Set<() => void>();

  function cancelPending(): void {
    pending?.cancel();
    pending = null;
  }

  function commit(next: ConnectivityPhase): void {
    const before = projectBannerState(phase);
    phase = next;
    // Notify only when the painted state changes: a reconfirmed offline, or a
    // disconnect report that keeps painting the state it found, adds no render.
    if (projectBannerState(phase) === before) {
      return;
    }
    // The banner's `getSnapshot` (`isOffline`) is unchanged on an unknown → online
    // edge, so it does not re-render there; the tri-state hook's `getSnapshot`
    // (`state`) does.
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
      commit({ kind: reachable ? 'online' : 'offline' });
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
      // A disconnect report that was still being confirmed is not evidence either
      // way: the state it replaced stands, and a later report decides again.
      if (phase.kind === 'confirming-offline') {
        commit({ kind: phase.previous });
      }
      // Unknown cancels confirmation but preserves the last committed state —
      // except committed-offline with the radio back up (e.g. airplane mode
      // switched to 3G while NetInfo's external reachability probe never
      // answers). Preserving offline there leaves the banner stale forever,
      // because no further event may ever arrive; the app's own probe (its
      // backend, not an external URL) is the decider instead (uxs3 spot
      // check, e6-after-net). A failed probe re-commits offline unchanged.
      if (projectBannerState(phase) === 'offline' && sourceState.isConnected === true) {
        void confirmConnectivity(attempt);
      }
      return;
    }
    if (status === 'online') {
      commit({ kind: 'online' });
      return;
    }
    // The report is not evidence yet, but a write dispatched in the window would
    // wait out its deadline on a transport that just went away.
    commit({ kind: 'confirming-offline', previous: projectBannerState(phase) });
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

  const isOffline = (): boolean => projectBannerState(phase) === 'offline';

  const getState = (): BannerState => projectBannerState(phase);

  const getPhase = (): ConnectivityPhase => phase;

  const destroy = (): void => {
    destroyed = true;
    generation += 1;
    cancelPending();
    unsubscribeSource();
    listeners.clear();
  };

  return { subscribe, isOffline, state: getState, phase: getPhase, destroy };
}
