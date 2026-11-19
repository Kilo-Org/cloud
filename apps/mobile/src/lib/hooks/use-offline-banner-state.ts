import { withDeadline } from '@kilocode/event-service';
import { addEventListener } from '@react-native-community/netinfo';
import { useSyncExternalStore } from 'react';

import { API_BASE_URL } from '@/lib/config';
import {
  isForcedOffline,
  subscribeConnectivityWithForceState,
  subscribeForceState,
} from '@/lib/force-state-fixture';
import {
  type BannerState,
  type ConnectivitySource,
  createOfflineBannerStore,
  type OfflineBannerStore,
  type OfflineBannerTimer,
  phaseBlocksWrites,
} from '@/lib/offline-banner-state';

const netInfoSource: ConnectivitySource = {
  subscribe: listener =>
    __DEV__
      ? subscribeConnectivityWithForceState(addEventListener, listener)
      : addEventListener(listener),
};

const defaultTimer: OfflineBannerTimer = {
  set(callback, delayMs) {
    const handle = setTimeout(callback, delayMs);
    return {
      cancel: () => {
        clearTimeout(handle);
      },
    };
  },
};

// One store per app, created lazily on first use and never destroyed, so
// every caller of the two hooks below shares a single NetInfo subscription
// (the app must not grow a second connectivity system).
let store: OfflineBannerStore | null = null;

function getStore(): OfflineBannerStore {
  if (store !== null) {
    return store;
  }
  const created = createOfflineBannerStore({
    source: netInfoSource,
    timer: defaultTimer,
    probe: async () => {
      // Dev-only `force-state/offline` link: the backend is unreachable too.
      if (__DEV__ && isForcedOffline()) {
        return false;
      }
      await withDeadline(3000, async signal => {
        await fetch(API_BASE_URL, { method: 'HEAD', signal });
      });
      // Any HTTP response proves reachability, including application errors.
      return true;
    },
  });
  store = created;
  if (__DEV__) {
    // Dev-only `force-state/offline` link: the network is known to be gone, so
    // the banner commits at once, before the link opens its next screen, and
    // that screen lays out under the banner from its first frame.
    const confirmForcedOffline = () => {
      if (isForcedOffline()) {
        created.confirmOffline();
      }
    };
    subscribeForceState(confirmForcedOffline);
    confirmForcedOffline();
  }
  return created;
}

export function useOfflineBannerState(): boolean {
  return useSyncExternalStore(getStore().subscribe, getStore().isOffline);
}

/**
 * Non-hook observation of committed connectivity changes, for app-lifetime
 * wiring that must react without mounting a component. The listener fires on
 * every committed state change (`online` / `offline` / `unknown`), reading the
 * current value with `getCommittedConnectivityStatus`.
 */
export function subscribeCommittedConnectivityStatus(listener: () => void): () => void {
  return getStore().subscribe(listener);
}

export function useCommittedConnectivityStatus(): BannerState {
  return useSyncExternalStore(getStore().subscribe, getStore().state);
}

/**
 * Non-hook snapshot of the committed connectivity state, for submit gates
 * that must not start a network write while the app has CONFIRMED offline:
 * a blocked request would pin the composer on a spinner until the UI
 * deadline (uxs3 spot check, e6-offline-hang). `unknown` never blocks —
 * only the same confirmed-offline state the banner paints does.
 */
export function getCommittedConnectivityStatus(): BannerState {
  return getStore().state();
}

/**
 * True while a write cannot complete. Gates refuse with their inline retryable
 * failure instead of dispatching into a transport that just went away.
 */
export function connectionRefusesWrites(): boolean {
  return phaseBlocksWrites(getStore().phase());
}
