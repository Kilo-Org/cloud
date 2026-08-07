import { addEventListener } from '@react-native-community/netinfo';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

import {
  type ConnectivitySource,
  createOfflineBannerStore,
  type OfflineBannerStore,
  type OfflineBannerTimer,
} from '@/lib/offline-banner-state';

const NOOP_SUBSCRIBE = (): (() => void) => () => {
  // No store on the first render; the effect creates one and destroys it on unmount.
};

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

export function useOfflineBannerState(): boolean {
  const [store, setStore] = useState<OfflineBannerStore | null>(null);
  useEffect(() => {
    const created = createOfflineBannerStore({ source: netInfoSource, timer: defaultTimer });
    setStore(created);
    return () => {
      created.destroy();
    };
  }, []);
  const getSnapshot = useCallback(() => store?.isOffline() ?? false, [store]);
  return useSyncExternalStore(store?.subscribe ?? NOOP_SUBSCRIBE, getSnapshot);
}
