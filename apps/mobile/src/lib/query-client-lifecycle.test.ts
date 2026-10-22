import { describe, expect, it, vi } from 'vitest';

import { installQueryClientNativeLifecycle } from '@/lib/query-client-lifecycle';

const committedConnectivity = vi.hoisted(() => ({
  status: 'unknown' as 'online' | 'offline' | 'unknown',
  subscribe: undefined as ((listener: () => void) => void) | undefined,
}));

vi.mock('@/lib/hooks/use-offline-banner-state', () => ({
  getCommittedConnectivityStatus: () => committedConnectivity.status,
  subscribeCommittedConnectivityStatus: (listener: () => void) => {
    committedConnectivity.subscribe = listener;
    return () => {
      committedConnectivity.subscribe = undefined;
    };
  },
}));

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
  let committedListener: (() => void) | undefined = undefined;
  let committedState: 'online' | 'offline' | 'unknown' = 'unknown';
  const removeAppStateListener = vi.fn();
  const removeConnectivityListener = vi.fn();
  const removeCommittedListener = vi.fn();

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
      onCommittedConnectivityChange: (listener: () => void) => {
        committedListener = listener;
        return removeCommittedListener;
      },
    },
    setAppState(nextState: AppState) {
      appState = nextState;
      appStateListener?.(nextState);
    },
    setConnectivity(nextState: ConnectivityState) {
      connectivityListener?.(nextState);
    },
    setCommitted(nextState: 'online' | 'offline' | 'unknown') {
      committedState = nextState;
      committedConnectivity.status = nextState;
      committedListener?.();
    },
    committed: () => committedState,
    removeAppStateListener,
    removeConnectivityListener,
    removeCommittedListener,
  };
}

function createBooleanSetterMock() {
  return vi.fn((value: boolean): void => {
    void value;
  });
}

function createOnlineManager(initial: boolean) {
  let online = initial;
  const setOnline = vi.fn((next: boolean): void => {
    online = next;
  });
  return {
    online: { setOnline, isOnline: () => online },
    setOnline,
  };
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
        online: { setOnline, isOnline: () => true },
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
        online: { setOnline, isOnline: () => true },
      },
    });

    native.setConnectivity({ isConnected: false, isInternetReachable: false });
    native.setConnectivity({ isConnected: true, isInternetReachable: true });
    cleanup();

    expect(setOnline).toHaveBeenNthCalledWith(1, false);
    expect(setOnline).toHaveBeenNthCalledWith(2, true);
    expect(native.removeConnectivityListener).toHaveBeenCalledTimes(1);
  });

  it('treats unknown reachability as offline for React Query', () => {
    const native = createSources();
    const setFocused = createBooleanSetterMock();
    const setOnline = createBooleanSetterMock();

    const cleanup = installQueryClientNativeLifecycle({
      sources: native.sources,
      managers: {
        focus: { setFocused },
        online: { setOnline, isOnline: () => true },
      },
    });

    native.setConnectivity({ isConnected: false, isInternetReachable: null });
    native.setConnectivity({ isConnected: true, isInternetReachable: null });
    native.setConnectivity({ isConnected: null, isInternetReachable: null });
    native.setConnectivity({ isConnected: true, isInternetReachable: true });
    cleanup();

    // Unknown must never count as online: React Query pauses while NetInfo
    // has not settled, and only a confirmed online state resumes it.
    expect(setOnline).toHaveBeenNthCalledWith(1, false);
    expect(setOnline).toHaveBeenNthCalledWith(2, false);
    expect(setOnline).toHaveBeenNthCalledWith(3, false);
    expect(setOnline).toHaveBeenNthCalledWith(4, true);
  });

  it('keeps a confirmed-online handover online when reachability stays unknown', () => {
    const native = createSources();
    const setFocused = createBooleanSetterMock();
    const manager = createOnlineManager(true);

    const cleanup = installQueryClientNativeLifecycle({
      sources: native.sources,
      managers: { focus: { setFocused }, online: manager.online },
    });

    // Wi-Fi → cellular handover: the radio reports connected while its
    // reachability probe never answers, and the probe store has already
    // confirmed online. The manager must not latch offline with no recovery
    // edge, so the unknown state reads the committed state.
    committedConnectivity.status = 'online';
    native.setConnectivity({ isConnected: true, isInternetReachable: null });
    cleanup();

    expect(manager.setOnline).toHaveBeenNthCalledWith(1, true);
  });

  it('keeps an unconfirmed unknown state offline during a handover', () => {
    const native = createSources();
    const setFocused = createBooleanSetterMock();
    const manager = createOnlineManager(false);

    const cleanup = installQueryClientNativeLifecycle({
      sources: native.sources,
      managers: { focus: { setFocused }, online: manager.online },
    });

    // The probe has not confirmed anything yet (boot, no probe answer): the
    // unknown state still pauses the manager.
    committedConnectivity.status = 'unknown';
    native.setConnectivity({ isConnected: true, isInternetReachable: null });
    cleanup();

    expect(manager.setOnline).toHaveBeenNthCalledWith(1, false);
  });

  it('flapping unknown → offline → online → offline is online only on the confirmed online state', () => {
    const native = createSources();
    const setFocused = createBooleanSetterMock();
    const setOnline = createBooleanSetterMock();

    const cleanup = installQueryClientNativeLifecycle({
      sources: native.sources,
      managers: {
        focus: { setFocused },
        online: { setOnline, isOnline: () => true },
      },
    });

    native.setConnectivity({ isConnected: null, isInternetReachable: null });
    native.setConnectivity({ isConnected: false, isInternetReachable: false });
    native.setConnectivity({ isConnected: true, isInternetReachable: true });
    native.setConnectivity({ isConnected: false, isInternetReachable: false });
    cleanup();

    // Only the confirmed online state resumes React Query; unknown and every
    // offline state pause it, so a paused query never surfaces an error state.
    expect(setOnline).toHaveBeenNthCalledWith(1, false);
    expect(setOnline).toHaveBeenNthCalledWith(2, false);
    expect(setOnline).toHaveBeenNthCalledWith(3, true);
    expect(setOnline).toHaveBeenNthCalledWith(4, false);
  });

  it('promotes a latched-offline manager on a committed online probe', () => {
    const native = createSources();
    const setFocused = createBooleanSetterMock();
    const manager = createOnlineManager(false);

    const cleanup = installQueryClientNativeLifecycle({
      sources: native.sources,
      managers: { focus: { setFocused }, online: manager.online },
    });

    // The radio returned but NetInfo's reachability probe never answered: the
    // manager stays offline, and the backend probe then commits online.
    native.setConnectivity({ isConnected: true, isInternetReachable: null });
    committedConnectivity.status = 'online';
    native.setCommitted('online');
    cleanup();

    expect(manager.setOnline).toHaveBeenCalledWith(true);
    expect(native.removeCommittedListener).toHaveBeenCalledTimes(1);
  });

  it('does not demote or double-set an already-online manager', () => {
    const native = createSources();
    const setFocused = createBooleanSetterMock();
    const manager = createOnlineManager(true);

    const cleanup = installQueryClientNativeLifecycle({
      sources: native.sources,
      managers: { focus: { setFocused }, online: manager.online },
    });

    committedConnectivity.status = 'online';
    native.setCommitted('online');
    committedConnectivity.status = 'offline';
    native.setCommitted('offline');
    cleanup();

    // NetInfo owns going offline: a probe commit never writes the manager.
    expect(manager.setOnline).not.toHaveBeenCalled();
  });

  it('leaves the manager latched offline when the probe has not confirmed online', () => {
    const native = createSources();
    const setFocused = createBooleanSetterMock();
    const manager = createOnlineManager(false);

    const cleanup = installQueryClientNativeLifecycle({
      sources: native.sources,
      managers: { focus: { setFocused }, online: manager.online },
    });

    committedConnectivity.status = 'unknown';
    native.setCommitted('unknown');
    committedConnectivity.status = 'offline';
    native.setCommitted('offline');
    cleanup();

    expect(manager.setOnline).not.toHaveBeenCalled();
  });
});
