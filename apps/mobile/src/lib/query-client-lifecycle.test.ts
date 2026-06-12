import { describe, expect, it, vi } from 'vitest';

import { installQueryClientNativeLifecycle } from '@/lib/query-client-lifecycle';

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

function createBooleanSetterMock() {
  return vi.fn((value: boolean): void => {
    void value;
  });
}

describe('installQueryClientNativeLifecycle', () => {
  it('mirrors native app focus into React Query focus state', () => {
    const native = createSources('background');
    const setFocused = createBooleanSetterMock();
    const setOnline = createBooleanSetterMock();

    const cleanup = installQueryClientNativeLifecycle({
      sources: native.sources,
      managers: {
        focus: { setFocused },
        online: { setOnline },
      },
    });

    native.setAppState('active');
    native.setAppState('background');
    cleanup();

    expect(setFocused).toHaveBeenNthCalledWith(1, false);
    expect(setFocused).toHaveBeenNthCalledWith(2, true);
    expect(setFocused).toHaveBeenNthCalledWith(3, false);
    expect(native.removeAppStateListener).toHaveBeenCalledTimes(1);
  });

  it('mirrors native connectivity into React Query online state', () => {
    const native = createSources();
    const setFocused = createBooleanSetterMock();
    const setOnline = createBooleanSetterMock();

    const cleanup = installQueryClientNativeLifecycle({
      sources: native.sources,
      managers: {
        focus: { setFocused },
        online: { setOnline },
      },
    });

    native.setConnectivity({ isConnected: false, isInternetReachable: false });
    native.setConnectivity({ isConnected: true, isInternetReachable: true });
    cleanup();

    expect(setOnline).toHaveBeenNthCalledWith(1, false);
    expect(setOnline).toHaveBeenNthCalledWith(2, true);
    expect(native.removeConnectivityListener).toHaveBeenCalledTimes(1);
  });

  it('falls back to isConnected when isInternetReachable is null', () => {
    const native = createSources();
    const setFocused = createBooleanSetterMock();
    const setOnline = createBooleanSetterMock();

    const cleanup = installQueryClientNativeLifecycle({
      sources: native.sources,
      managers: {
        focus: { setFocused },
        online: { setOnline },
      },
    });

    native.setConnectivity({ isConnected: false, isInternetReachable: null });
    native.setConnectivity({ isConnected: true, isInternetReachable: null });
    native.setConnectivity({ isConnected: null, isInternetReachable: null });
    cleanup();

    expect(setOnline).toHaveBeenNthCalledWith(1, false);
    expect(setOnline).toHaveBeenNthCalledWith(2, true);
    expect(setOnline).toHaveBeenNthCalledWith(3, true);
  });
});
