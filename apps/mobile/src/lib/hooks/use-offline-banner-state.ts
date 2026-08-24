import { addEventListener } from '@react-native-community/netinfo';
import { useSyncExternalStore } from 'react';

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
  store ??= createOfflineBannerStore({ source: netInfoSource, timer: defaultTimer });
  return store;
}

export function useOfflineBannerState(): boolean {
  return useSyncExternalStore(getStore().subscribe, getStore().isOffline);
}

export function useCommittedConnectivityStatus(): BannerState {
  return useSyncExternalStore(getStore().subscribe, getStore().state);
}
