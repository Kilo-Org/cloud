import { type ConnectionLifecycleHooks } from '@kilocode/cloud-agent-sdk';
import { addEventListener } from '@react-native-community/netinfo';
import { AppState, type AppStateStatus } from 'react-native';

import { type ConnectivityState, connectivityStatus } from '@/lib/connectivity-online';

type NativeLifecycleSources = {
  getAppState: () => AppStateStatus;
  onAppStateChange: (listener: (state: AppStateStatus) => void) => () => void;
  onConnectivityChange: (listener: (state: ConnectivityState) => void) => () => void;
};

const nativeLifecycleSources: NativeLifecycleSources = {
  getAppState: () => AppState.currentState,
  onAppStateChange: listener => {
    const subscription = AppState.addEventListener('change', listener);
    return () => {
      subscription.remove();
    };
  },
  onConnectivityChange: listener => addEventListener(listener),
};

export function createNativeUserWebConnectionLifecycleHooks(
  sources: NativeLifecycleSources = nativeLifecycleSources
): ConnectionLifecycleHooks {
  return {
    onVisibilityChange: (onResume, onHidden) => {
      let state = sources.getAppState();
      return sources.onAppStateChange(nextState => {
        const wasActive = state === 'active';
        const isActive = nextState === 'active';
        state = nextState;

        if (isActive && !wasActive) {
          onResume();
        } else if (!isActive && wasActive) {
          onHidden();
        }
      });
    },
    onOnline: onOnline => {
      // NetInfo replays the current connectivity to every new listener, so the
      // first emission after subscribing is a baseline, not a recovery. Only a
      // later offline/unknown → online transition is a real recovery. Firing on
      // the baseline re-entered the SDK metadata-recovery retry on every failed
      // open (the hook is re-registered per failure), an endless retry loop
      // that kept the skeleton up and never surfaced the terminal load error.
      let previousStatus: 'online' | 'offline' | 'unknown' | null = null;
      return sources.onConnectivityChange(state => {
        const status = connectivityStatus(state);
        if (previousStatus === null) {
          previousStatus = status;
          return;
        }
        // Resume only on a real recovery: offline → online, or the first
        // online after an unknown boot. Never while unknown, and never on
        // unknown → offline.
        if (status === 'online' && (previousStatus === 'offline' || previousStatus === 'unknown')) {
          onOnline();
        }
        previousStatus = status;
      });
    },
  };
}
