import { withDeadline } from '@kilocode/event-service';
import { addEventListener } from '@react-native-community/netinfo';
import { useSyncExternalStore } from 'react';

import { API_BASE_URL } from '@/lib/config';
import { type ConnectivityStatus } from '@/lib/connectivity-online';
import {
  type BannerState,
  type ConnectivitySource,
  createOfflineBannerStore,
  type OfflineBannerStore,
  type OfflineBannerTimer,
} from '@/lib/offline-banner-state';

const netInfoSource: ConnectivitySource = {
  subscribe: listener => addEventListener(listener),
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
  store ??= createOfflineBannerStore({
    source: netInfoSource,
    timer: defaultTimer,
    probe: async () => {
      await withDeadline(3000, async signal => {
        await fetch(API_BASE_URL, { method: 'HEAD', signal });
      });
      // Any HTTP response proves reachability, including application errors.
      return true;
    },
  });
  return store;
}

export function useOfflineBannerState(): boolean {
  return useSyncExternalStore(getStore().subscribe, getStore().isOffline);
}

export function useCommittedConnectivityStatus(): BannerState {
  return useSyncExternalStore(getStore().subscribe, getStore().state);
}

/**
 * NetInfo's immediate connectivity classification, before the banner's
 * five-second confirm-offline debounce commits `useCommittedConnectivityStatus`.
 * A definite `offline` here lets a surface settle a paused query at once
 * instead of waiting for the banner to commit.
 */
export function useConnectivityStatus(): ConnectivityStatus {
  return useSyncExternalStore(getStore().subscribeSourceStatus, getStore().sourceStatus);
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
