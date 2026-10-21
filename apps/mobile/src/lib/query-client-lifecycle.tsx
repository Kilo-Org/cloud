import { addEventListener } from '@react-native-community/netinfo';
import { focusManager, onlineManager } from '@tanstack/react-query';
import { useEffect } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import { type ConnectivityState, connectivityStatus, isOnline } from '@/lib/connectivity-online';
import {
  getCommittedConnectivityStatus,
  subscribeCommittedConnectivityStatus,
} from '@/lib/hooks/use-offline-banner-state';

type QueryClientLifecycleSources = {
  getAppState: () => AppStateStatus;
  onAppStateChange: (listener: (state: AppStateStatus) => void) => () => void;
  onConnectivityChange: (listener: (state: ConnectivityState) => void) => () => void;
  /** Commits of the app's confirmed connectivity (probe-backed), or null to opt out. */
  onCommittedConnectivityChange: ((listener: () => void) => () => void) | null;
};

type QueryClientLifecycleManagers = {
  focus: Pick<typeof focusManager, 'setFocused'>;
  online: Pick<typeof onlineManager, 'setOnline' | 'isOnline'>;
};

type QueryClientNativeLifecycleOptions = {
  sources?: QueryClientLifecycleSources;
  managers?: QueryClientLifecycleManagers;
};

const nativeLifecycleSources: QueryClientLifecycleSources = {
  getAppState: () => AppState.currentState,
  onAppStateChange: listener => {
    const subscription = AppState.addEventListener('change', listener);
    return () => {
      subscription.remove();
    };
  },
  onConnectivityChange: listener => addEventListener(listener),
  onCommittedConnectivityChange: subscribeCommittedConnectivityStatus,
};

const defaultManagers: QueryClientLifecycleManagers = {
  focus: focusManager,
  online: onlineManager,
};

export function installQueryClientNativeLifecycle({
  sources = nativeLifecycleSources,
  managers = defaultManagers,
}: QueryClientNativeLifecycleOptions = {}): () => void {
  managers.focus.setFocused(sources.getAppState() === 'active');

  const removeAppStateListener = sources.onAppStateChange(nextState => {
    managers.focus.setFocused(nextState === 'active');
  });
  const removeConnectivityListener = sources.onConnectivityChange(nextState => {
    // An `unknown` NetInfo report (reachability not settled) pauses the manager
    // even when the app's probe has already confirmed reachability. That
    // unknown never re-fires and the probe store never re-commits an unchanged
    // state, so an unchanged committed-online would stay latched offline.
    // The probe's committed state is the better answer there: a handover
    // (Wi-Fi → cellular) with confirmed reachability stays online.
    managers.online.setOnline(
      isOnline(nextState) ||
        (connectivityStatus(nextState) === 'unknown' &&
          getCommittedConnectivityStatus() === 'online')
    );
  });
  // NetInfo can commit `isConnected: true` with `isInternetReachable: null`
  // after the radio returns and never fire again, leaving the manager offline
  // while the app's backend probe has confirmed reachability (the same
  // committed-online state the offline banner clears on). Paused queries only
  // resume on an online edge, so that latched offline kept first loads on
  // skeleton rows forever (agents list after connectivity returns). Promote
  // only: NetInfo stays the sole source for going offline.
  const removeCommittedConnectivityListener =
    sources.onCommittedConnectivityChange?.(() => {
      if (getCommittedConnectivityStatus() === 'online' && !managers.online.isOnline()) {
        managers.online.setOnline(true);
      }
    }) ?? null;

  return () => {
    removeAppStateListener();
    removeConnectivityListener();
    removeCommittedConnectivityListener?.();
  };
}

export function QueryClientNativeLifecycle() {
  useEffect(() => installQueryClientNativeLifecycle(), []);

  return null;
}
