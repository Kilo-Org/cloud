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
      // Boot is unknown: until NetInfo settles we cannot claim the socket is
      // reachable, so the first confirmed online is a recovery from unknown.
      let previousStatus: 'online' | 'offline' | 'unknown' = 'unknown';
      return sources.onConnectivityChange(state => {
        const status = connectivityStatus(state);
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
