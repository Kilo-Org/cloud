import { describe, expect, it, vi } from 'vitest';
import { createNativeUserWebConnectionLifecycleHooks } from '@/lib/user-web-connection-lifecycle';

vi.mock('react-native', () => ({
  AppState: { currentState: 'active', addEventListener: vi.fn() },
}));

vi.mock('@react-native-community/netinfo', () => ({
  addEventListener: vi.fn(),
}));

type AppState = 'active' | 'background' | 'inactive';
type ConnectivityState = { isConnected: boolean | null; isInternetReachable: boolean | null };

function createSources(initialAppState: AppState = 'active') {
  let appState = initialAppState;
  let appStateListener: ((state: AppState) => void) | undefined = undefined;
  let connectivityListener: ((state: ConnectivityState) => void) | undefined = undefined;
  const removeAppStateListener = vi.fn();
  const removeConnectivityListener = vi.fn();

  return {
    sources: {
      getAppState: () => appState,
      onAppStateChange: (listener: (state: AppState) => void) => {
        appStateListener = listener;
        return removeAppStateListener;
      },
      onConnectivityChange: (listener: (state: ConnectivityState) => void) => {
        connectivityListener = listener;
        return removeConnectivityListener;
      },
    },
    setAppState(nextState: AppState) {
      appState = nextState;
      appStateListener?.(nextState);
    },
    setConnectivity(nextState: ConnectivityState) {
      connectivityListener?.(nextState);
    },
    removeAppStateListener,
    removeConnectivityListener,
  };
}

describe('createNativeUserWebConnectionLifecycleHooks', () => {
  it('resumes only after the app returns to the foreground', () => {
    const native = createSources();
    const hooks = createNativeUserWebConnectionLifecycleHooks(native.sources);
    const onResume = vi.fn();
    const onHidden = vi.fn();
    const cleanup = hooks.onVisibilityChange?.(
      () => {
        onResume();
      },
      () => {
        onHidden();
      }
    );

    native.setAppState('background');
    native.setAppState('active');
    native.setAppState('active');
    cleanup?.();

    expect(onHidden).toHaveBeenCalledTimes(1);
    expect(onResume).toHaveBeenCalledTimes(1);
    expect(native.removeAppStateListener).toHaveBeenCalledTimes(1);
  });

  it('reports only offline-to-online network recovery', () => {
    const native = createSources();
    const hooks = createNativeUserWebConnectionLifecycleHooks(native.sources);
    const onOnline = vi.fn();
    const cleanup = hooks.onOnline?.(() => {
      onOnline();
    });

    native.setConnectivity({ isConnected: true, isInternetReachable: true });
    native.setConnectivity({ isConnected: true, isInternetReachable: true });
    native.setConnectivity({ isConnected: false, isInternetReachable: false });
    native.setConnectivity({ isConnected: true, isInternetReachable: true });
    cleanup?.();

    expect(onOnline).toHaveBeenCalledTimes(1);
    expect(native.removeConnectivityListener).toHaveBeenCalledTimes(1);
  });
});
