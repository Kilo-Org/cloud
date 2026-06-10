import { AppState, type AppStateStatus } from 'react-native';
import { addEventListener, type NetInfoState } from '@react-native-community/netinfo';
import { type ConnectionLifecycleHooks } from 'cloud-agent-sdk';

type ConnectivityState = Pick<NetInfoState, 'isConnected' | 'isInternetReachable'>;

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

function isOnline(state: ConnectivityState): boolean {
  return state.isInternetReachable ?? state.isConnected ?? true;
}

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
      let previousOnline: boolean | undefined = undefined;
      return sources.onConnectivityChange(state => {
        const online = isOnline(state);
        if (online && previousOnline === false) {
          onOnline();
        }
        previousOnline = online;
      });
    },
  };
}
