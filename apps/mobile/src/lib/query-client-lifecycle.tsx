import { addEventListener, type NetInfoState } from '@react-native-community/netinfo';
import { focusManager, onlineManager } from '@tanstack/react-query';
import { useEffect } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

type ConnectivityState = Pick<NetInfoState, 'isConnected' | 'isInternetReachable'>;

type QueryClientLifecycleSources = {
  getAppState: () => AppStateStatus;
  onAppStateChange: (listener: (state: AppStateStatus) => void) => () => void;
  onConnectivityChange: (listener: (state: ConnectivityState) => void) => () => void;
};

type QueryClientLifecycleManagers = {
  focus: Pick<typeof focusManager, 'setFocused'>;
  online: Pick<typeof onlineManager, 'setOnline'>;
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
};

const defaultManagers: QueryClientLifecycleManagers = {
  focus: focusManager,
  online: onlineManager,
};

function isOnline(state: ConnectivityState): boolean {
  return state.isInternetReachable ?? state.isConnected ?? true;
}

export function installQueryClientNativeLifecycle({
  sources = nativeLifecycleSources,
  managers = defaultManagers,
}: QueryClientNativeLifecycleOptions = {}): () => void {
  managers.focus.setFocused(sources.getAppState() === 'active');

  const removeAppStateListener = sources.onAppStateChange(nextState => {
    managers.focus.setFocused(nextState === 'active');
  });
  const removeConnectivityListener = sources.onConnectivityChange(nextState => {
    managers.online.setOnline(isOnline(nextState));
  });

  return () => {
    removeAppStateListener();
    removeConnectivityListener();
  };
}

export function QueryClientNativeLifecycle() {
  useEffect(() => installQueryClientNativeLifecycle(), []);

  return null;
}
