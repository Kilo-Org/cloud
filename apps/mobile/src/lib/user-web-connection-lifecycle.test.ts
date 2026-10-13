import { createBaseConnection } from '@kilocode/cloud-agent-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createNativeUserWebConnectionLifecycleHooks,
  HIDDEN_SOCKET_PAUSE_DELAY_MS,
} from '@/lib/user-web-connection-lifecycle';

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

  describe('with a socket connection', () => {
    type FakeSocket = {
      readyState: number;
      onmessage: ((event: { data: unknown }) => void) | null;
      onclose: ((event: { code: number }) => void) | null;
      close: () => void;
    };

    afterEach(() => {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    });

    function connectWithNativeHooks(initialAppState: AppState = 'active') {
      vi.useFakeTimers();
      const sockets: FakeSocket[] = [];
      const FakeWebSocket = Object.assign(
        vi.fn(function FakeWebSocket() {
          const socket: FakeSocket = {
            readyState: 1,
            onmessage: null,
            onclose: null,
            close: vi.fn(() => {
              socket.readyState = 3;
            }),
          };
          sockets.push(socket);
          return socket;
        }),
        { OPEN: 1, CLOSED: 3 }
      );
      vi.stubGlobal('WebSocket', FakeWebSocket);
      const native = createSources(initialAppState);
      const refreshAuth = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
      const transitions: string[] = [];
      const connection = createBaseConnection<string>({
        buildUrl: () => 'wss://example.test/api/user/web',
        parseMessage: data => (typeof data === 'string' ? { type: 'event', payload: data } : null),
        onEvent: payload => {
          transitions.push(`event:${payload}`);
        },
        onConnected: () => {
          transitions.push('connected');
        },
        onDisconnected: () => {
          transitions.push('disconnected');
        },
        refreshAuth,
        lifecycleHooks: createNativeUserWebConnectionLifecycleHooks(native.sources),
      });
      connection.connect();
      sockets[0]?.onmessage?.({ data: 'hello' });
      return { connection, native, refreshAuth, sockets, transitions };
    }

    it('closes the socket after the app stays in the background, and reconnects only when active', async () => {
      const { connection, native, refreshAuth, sockets, transitions } = connectWithNativeHooks();

      native.setAppState('background');
      vi.advanceTimersByTime(HIDDEN_SOCKET_PAUSE_DELAY_MS);
      expect(sockets[0]?.close).toHaveBeenCalledTimes(1);
      expect(transitions).toEqual(['connected', 'event:hello', 'disconnected']);

      native.setConnectivity({ isConnected: false, isInternetReachable: false });
      native.setConnectivity({ isConnected: true, isInternetReachable: true });
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(sockets).toHaveLength(1);
      expect(refreshAuth).not.toHaveBeenCalled();

      native.setAppState('active');
      await vi.advanceTimersByTimeAsync(0);
      expect(refreshAuth).toHaveBeenCalledTimes(1);
      expect(sockets).toHaveLength(2);
      connection.destroy();
    });

    it('keeps the socket through a short trip out of the app', async () => {
      const { connection, native, refreshAuth, sockets } = connectWithNativeHooks();

      native.setAppState('inactive');
      vi.advanceTimersByTime(HIDDEN_SOCKET_PAUSE_DELAY_MS - 1);
      sockets[0]?.onmessage?.({ data: 'still here' });
      native.setAppState('active');
      await vi.advanceTimersByTimeAsync(HIDDEN_SOCKET_PAUSE_DELAY_MS);

      expect(sockets).toHaveLength(1);
      expect(sockets[0]?.close).not.toHaveBeenCalled();
      expect(refreshAuth).not.toHaveBeenCalled();
      connection.destroy();
    });

    it('keeps reconnecting a connection opened in the background, as a background approve needs', async () => {
      const { connection, sockets } = connectWithNativeHooks('background');

      sockets[0]?.onclose?.({ code: 1006 });
      await vi.advanceTimersByTimeAsync(60_000);

      expect(sockets.length).toBeGreaterThan(1);
      connection.destroy();
    });
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

  it('ignores the connectivity replay on subscribe and resumes only on a later offline → online', () => {
    const native = createSources();
    const hooks = createNativeUserWebConnectionLifecycleHooks(native.sources);
    const onOnline = vi.fn();
    const cleanup = hooks.onOnline?.(() => {
      onOnline();
    });

    // NetInfo replays the current state to every new listener. An online replay
    // is a baseline, not a recovery: firing it re-entered the SDK
    // metadata-recovery retry in a loop on every failed session open, so the
    // terminal load error never surfaced (p6).
    native.setConnectivity({ isConnected: true, isInternetReachable: true });
    expect(onOnline).not.toHaveBeenCalled();

    native.setConnectivity({ isConnected: false, isInternetReachable: false });
    native.setConnectivity({ isConnected: true, isInternetReachable: true });
    expect(onOnline).toHaveBeenCalledTimes(1);
    cleanup?.();
  });

  it('treats an offline replay as the baseline and resumes when connectivity returns', () => {
    const native = createSources();
    const hooks = createNativeUserWebConnectionLifecycleHooks(native.sources);
    const onOnline = vi.fn();
    const cleanup = hooks.onOnline?.(() => {
      onOnline();
    });

    native.setConnectivity({ isConnected: false, isInternetReachable: false });
    expect(onOnline).not.toHaveBeenCalled();

    native.setConnectivity({ isConnected: true, isInternetReachable: true });
    expect(onOnline).toHaveBeenCalledTimes(1);
    cleanup?.();
  });
});
