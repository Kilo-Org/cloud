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

  it('resumes on unknown → online (first online after boot) and on offline → online', () => {
    const native = createSources();
    const hooks = createNativeUserWebConnectionLifecycleHooks(native.sources);
    const onOnline = vi.fn();
    const cleanup = hooks.onOnline?.(() => {
      onOnline();
    });

    // Boot is unknown: no resume until NetInfo confirms reachability.
    native.setConnectivity({ isConnected: null, isInternetReachable: null });
    native.setConnectivity({ isConnected: true, isInternetReachable: null });
    // First confirmed online resumes the socket (unknown → online).
    native.setConnectivity({ isConnected: true, isInternetReachable: true });
    // A repeat online report does not resume again.
    native.setConnectivity({ isConnected: true, isInternetReachable: true });
    // Going offline does not resume.
    native.setConnectivity({ isConnected: false, isInternetReachable: false });
    // Recovery resumes once more (offline → online).
    native.setConnectivity({ isConnected: true, isInternetReachable: true });
    cleanup?.();

    expect(onOnline).toHaveBeenCalledTimes(2);
    expect(native.removeConnectivityListener).toHaveBeenCalledTimes(1);
  });

  it('does not resume while unknown or on unknown → offline', () => {
    const native = createSources();
    const hooks = createNativeUserWebConnectionLifecycleHooks(native.sources);
    const onOnline = vi.fn();
    const cleanup = hooks.onOnline?.(() => {
      onOnline();
    });

    native.setConnectivity({ isConnected: null, isInternetReachable: null });
    native.setConnectivity({ isConnected: true, isInternetReachable: null });
    native.setConnectivity({ isConnected: false, isInternetReachable: false });
    cleanup?.();

    expect(onOnline).not.toHaveBeenCalled();
    expect(native.removeConnectivityListener).toHaveBeenCalledTimes(1);
  });
});
