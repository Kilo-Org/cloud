/* eslint-disable max-lines -- one helper's whole launch contract: both platforms, the abort edges and the foreground return. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  launchConnectGateBrowser,
  openAuthorizationAndWaitForReturn,
} from './connect-gate-platform';

const mocks = vi.hoisted(() => ({
  platform: { OS: 'ios' },
  openAuthSessionAsync: vi.fn<(url: string) => Promise<{ type: string }>>(),
  openBrowserAsync: vi.fn<(url: string) => Promise<unknown>>(),
  addAppStateListener: vi.fn(),
  appState: { currentState: undefined as string | undefined },
  subscriptions: [] as {
    remove: ReturnType<typeof vi.fn>;
    listener: (state: string) => void;
  }[],
}));

vi.mock('react-native', () => ({
  Platform: mocks.platform,
  AppState: {
    addEventListener: mocks.addAppStateListener,
    get currentState() {
      return mocks.appState.currentState;
    },
  },
}));
vi.mock('expo-web-browser', () => ({
  openAuthSessionAsync: mocks.openAuthSessionAsync,
  openBrowserAsync: mocks.openBrowserAsync,
  WebBrowserResultType: { OPENED: 'opened', CANCEL: 'cancel', DISMISS: 'dismiss' },
}));

function emitAppState(state: string) {
  for (const subscription of mocks.subscriptions) {
    subscription.listener(state);
  }
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.subscriptions.length = 0;
  mocks.appState.currentState = undefined;
  mocks.addAppStateListener.mockImplementation(
    (_event: string, listener: (state: string) => void) => {
      const subscription = { remove: vi.fn(), listener };
      mocks.subscriptions.push(subscription);
      return { remove: subscription.remove };
    }
  );
});

function flushMicrotasks(): Promise<unknown> {
  // A few settled microtasks: enough for the detached follow-up to reach its
  // abort or report guard, without a wall-clock wait.
  return Promise.all([Promise.resolve(), Promise.resolve(), Promise.resolve(), Promise.resolve()]);
}

function returnHandlers() {
  return { onReturn: vi.fn().mockResolvedValue(undefined), onOpenFailure: vi.fn() };
}

describe('iOS launch', () => {
  beforeEach(() => {
    mocks.platform.OS = 'ios';
  });

  it('opens the native auth session and refetches when it resolves', async () => {
    mocks.openAuthSessionAsync.mockResolvedValue({ type: 'cancel' });
    const handlers = returnHandlers();

    await launchConnectGateBrowser('https://example.com/connect', handlers);

    expect(mocks.openAuthSessionAsync).toHaveBeenCalledExactlyOnceWith(
      'https://example.com/connect'
    );
    expect(mocks.openBrowserAsync).not.toHaveBeenCalled();
    // The foreground subscription is cross-platform: iOS registers it too, and
    // the native auth session's own resolution means it is only awaited when
    // the browser cannot report its dismissal.
    expect(mocks.addAppStateListener).toHaveBeenCalledOnce();
    expect(mocks.subscriptions[0]?.remove).toHaveBeenCalledOnce();
    expect(handlers.onReturn).toHaveBeenCalledOnce();
    expect(handlers.onOpenFailure).not.toHaveBeenCalled();
  });
});

describe('Android launch', () => {
  beforeEach(() => {
    mocks.platform.OS = 'android';
  });

  it('opens a plain browser and refetches when the app returns to the foreground', async () => {
    mocks.openBrowserAsync.mockResolvedValue({ type: 'opened' });
    const handlers = returnHandlers();

    const launch = launchConnectGateBrowser('https://example.com/connect', handlers);
    await Promise.resolve();

    expect(mocks.openBrowserAsync).toHaveBeenCalledExactlyOnceWith('https://example.com/connect');
    expect(mocks.openAuthSessionAsync).not.toHaveBeenCalled();
    expect(mocks.subscriptions).toHaveLength(1);
    expect(handlers.onReturn).not.toHaveBeenCalled();

    emitAppState('background');
    expect(handlers.onReturn).not.toHaveBeenCalled();
    emitAppState('active');
    await launch;

    expect(handlers.onReturn).toHaveBeenCalledOnce();
    expect(handlers.onOpenFailure).not.toHaveBeenCalled();
    expect(mocks.subscriptions[0]?.remove).toHaveBeenCalledOnce();
  });

  it('drops the foreground listener when the browser fails to open', async () => {
    mocks.openBrowserAsync.mockRejectedValue(new Error('no browser'));
    const handlers = { onReturn: vi.fn(), onOpenFailure: vi.fn() };

    await expect(
      launchConnectGateBrowser('https://example.com/connect', handlers)
    ).resolves.toBeUndefined();

    expect(handlers.onOpenFailure).toHaveBeenCalledOnce();
    expect(handlers.onReturn).not.toHaveBeenCalled();
    expect(mocks.subscriptions[0]?.remove).toHaveBeenCalledOnce();

    // A later foreground cannot stray-refetch: the listener is gone and the
    // launch has already settled.
    emitAppState('active');
    expect(handlers.onReturn).not.toHaveBeenCalled();
  });

  it('recovers a later launch after one fails to open', async () => {
    mocks.openBrowserAsync
      .mockRejectedValueOnce(new Error('no browser'))
      .mockResolvedValueOnce({ type: 'opened' });
    const handlers = returnHandlers();

    await launchConnectGateBrowser('https://example.com/connect', handlers);
    expect(handlers.onOpenFailure).toHaveBeenCalledOnce();
    expect(handlers.onReturn).not.toHaveBeenCalled();

    // The retry must not inherit the failed launch's stuck state (KILO-APP-22).
    const retry = launchConnectGateBrowser('https://example.com/connect', handlers);
    await Promise.resolve();
    emitAppState('active');
    await retry;

    expect(handlers.onReturn).toHaveBeenCalledOnce();
    expect(handlers.onOpenFailure).toHaveBeenCalledOnce();
  });

  it('aborts a foreground wait without refetching and allows a fresh launch', async () => {
    mocks.openBrowserAsync.mockResolvedValue({ type: 'opened' });
    const controller = new AbortController();
    const handlers = {
      signal: controller.signal,
      onReturn: vi.fn(),
      onOpenFailure: vi.fn(),
    };
    const launch = launchConnectGateBrowser('https://example.com/connect', handlers);
    await Promise.resolve();
    controller.abort();
    await launch;

    expect(mocks.subscriptions[0]?.remove).toHaveBeenCalledOnce();
    const retryHandlers = { onReturn: vi.fn(), onOpenFailure: vi.fn() };
    const retry = launchConnectGateBrowser('https://example.com/connect', retryHandlers);
    emitAppState('active');
    await retry;
    expect(handlers.onReturn).not.toHaveBeenCalled();
    expect(handlers.onOpenFailure).not.toHaveBeenCalled();
    expect(retryHandlers.onReturn).toHaveBeenCalledOnce();
    expect(mocks.subscriptions[1]?.remove).toHaveBeenCalledOnce();
  });
});

describe.each(['ios', 'android'])('shared launch contract on %s', os => {
  const openFn = () => (os === 'android' ? mocks.openBrowserAsync : mocks.openAuthSessionAsync);

  /** A launch that stays open until the test settles it. */
  function pendingLaunch() {
    const pending = Promise.withResolvers<{ type: string }>();
    openFn().mockReturnValue(pending.promise);
    return pending;
  }

  beforeEach(() => {
    mocks.platform.OS = os;
  });

  it('reports a failed launch through onOpenFailure and never onReturn', async () => {
    if (os === 'android') {
      mocks.openBrowserAsync.mockRejectedValue(new Error('no browser'));
    } else {
      mocks.openAuthSessionAsync.mockRejectedValue(new Error('no browser'));
    }
    const handlers = { onReturn: vi.fn(), onOpenFailure: vi.fn() };

    await expect(
      launchConnectGateBrowser('https://example.com/connect', handlers)
    ).resolves.toBeUndefined();
    expect(handlers.onOpenFailure).toHaveBeenCalledOnce();
    expect(handlers.onReturn).not.toHaveBeenCalled();
  });

  it('does not launch or notify a caller whose signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const handlers = {
      signal: controller.signal,
      onReturn: vi.fn(),
      onOpenFailure: vi.fn(),
    };

    await launchConnectGateBrowser('https://example.com/connect', handlers);
    expect(mocks.openBrowserAsync).not.toHaveBeenCalled();
    expect(mocks.openAuthSessionAsync).not.toHaveBeenCalled();
    expect(mocks.addAppStateListener).not.toHaveBeenCalled();
    expect(handlers.onReturn).not.toHaveBeenCalled();
    expect(handlers.onOpenFailure).not.toHaveBeenCalled();
  });

  it.each(['resolve', 'reject'])(
    'ends a pending launch on abort before a late %s',
    async outcome => {
      const pending = Promise.withResolvers<{ type: string }>();
      mocks.openBrowserAsync.mockReturnValue(pending.promise);
      mocks.openAuthSessionAsync.mockReturnValue(pending.promise);
      const controller = new AbortController();
      const removeAbortListener = vi.spyOn(controller.signal, 'removeEventListener');
      const handlers = {
        signal: controller.signal,
        onReturn: vi.fn(),
        onOpenFailure: vi.fn(),
      };

      const launch = launchConnectGateBrowser('https://example.com/connect', handlers);
      controller.abort();
      await launch;
      // The foreground subscription is registered on both platforms, and abort
      // drops it on both.
      expect(mocks.subscriptions[0]?.remove).toHaveBeenCalledOnce();
      expect(removeAbortListener).toHaveBeenCalledExactlyOnceWith('abort', expect.any(Function));

      if (outcome === 'resolve') {
        pending.resolve({ type: 'cancel' });
      } else {
        pending.reject(new Error('late launch failure'));
      }
      emitAppState('active');
      await Promise.resolve();
      expect(handlers.onReturn).not.toHaveBeenCalled();
      expect(handlers.onOpenFailure).not.toHaveBeenCalled();
    }
  );

  it.each(['return', 'failure'])('removes the abort listener after normal %s', async outcome => {
    const controller = new AbortController();
    const addAbortListener = vi.spyOn(controller.signal, 'addEventListener');
    const removeAbortListener = vi.spyOn(controller.signal, 'removeEventListener');
    const handlers = {
      signal: controller.signal,
      onReturn: vi.fn(),
      onOpenFailure: vi.fn(),
    };
    if (outcome === 'failure') {
      openFn().mockRejectedValue(new Error('no browser'));
    } else {
      mocks.openBrowserAsync.mockResolvedValue({ type: 'opened' });
      mocks.openAuthSessionAsync.mockResolvedValue({ type: 'cancel' });
    }

    const launch = launchConnectGateBrowser('https://example.com/connect', handlers);
    // Let the browser's own report land first: this test isolates the abort
    // listener's cleanup, not the foreground race below.
    await Promise.resolve();
    emitAppState('active');
    await launch;
    expect(removeAbortListener).toHaveBeenCalledExactlyOnceWith(
      'abort',
      addAbortListener.mock.calls[0]?.[1]
    );
    expect(handlers.onReturn).toHaveBeenCalledTimes(outcome === 'return' ? 1 : 0);
    expect(handlers.onOpenFailure).toHaveBeenCalledTimes(outcome === 'failure' ? 1 : 0);
    controller.abort();
    // Registered on both platforms, removed on both.
    expect(mocks.subscriptions[0]?.remove).toHaveBeenCalledOnce();
  });

  it('ends the wait when the app is back even if the launch never reports', async () => {
    // The reported failure: the sheet closes, the app is foreground again, and
    // the platform's completion never arrives. The caller must not stay in its
    // "in progress" state waiting for that report.
    pendingLaunch();
    const handlers = returnHandlers();

    const launch = launchConnectGateBrowser('https://example.com/connect', handlers);
    emitAppState('background');
    emitAppState('active');
    await expect(launch).resolves.toBeUndefined();

    expect(handlers.onReturn).toHaveBeenCalledOnce();
    expect(handlers.onOpenFailure).not.toHaveBeenCalled();
    expect(mocks.subscriptions[0]?.remove).toHaveBeenCalledOnce();
  });

  it('ignores a launch failure that lands after the foreground ended the wait', async () => {
    const pending = pendingLaunch();
    const handlers = returnHandlers();

    const launch = launchConnectGateBrowser('https://example.com/connect', handlers);
    emitAppState('active');
    await launch;

    // Settled union: a late rejection of the losing branch must not surface as
    // a browser error or an unhandled rejection.
    pending.reject(new Error('late launch failure'));
    await Promise.resolve();

    expect(handlers.onReturn).toHaveBeenCalledOnce();
    expect(handlers.onOpenFailure).not.toHaveBeenCalled();
  });

  it('needs a real return, not an active delivery while the app never left', async () => {
    mocks.appState.currentState = 'active';
    pendingLaunch();
    const handlers = returnHandlers();

    const launch = launchConnectGateBrowser('https://example.com/connect', handlers);
    // An `active` that follows another `active` is not a return to the app.
    emitAppState('active');
    await Promise.resolve();
    expect(handlers.onReturn).not.toHaveBeenCalled();

    emitAppState('background');
    emitAppState('active');
    await expect(launch).resolves.toBeUndefined();
    expect(handlers.onReturn).toHaveBeenCalledOnce();
  });

  it('refreshes again when the sheet completes after the app already came back', async () => {
    mocks.appState.currentState = 'active';
    const pending = pendingLaunch();
    const handlers = returnHandlers();

    const launch = launchConnectGateBrowser('https://example.com/connect', handlers);
    emitAppState('background');
    emitAppState('active');
    await launch;
    expect(handlers.onReturn).toHaveBeenCalledOnce();

    // The sign-in completed after the return edge: the status must be read
    // again, or a completed connection would leave the gate on Connect.
    pending.resolve({ type: 'cancel' });
    await vi.waitFor(() => {
      expect(handlers.onReturn).toHaveBeenCalledTimes(2);
    });
  });

  it('stops waiting for the sheet once the caller aborts', async () => {
    mocks.appState.currentState = 'active';
    const pending = pendingLaunch();
    const controller = new AbortController();
    const handlers = { ...returnHandlers(), signal: controller.signal };
    const launch = launchConnectGateBrowser('https://example.com/connect', handlers);
    emitAppState('background');
    emitAppState('active');
    await launch;
    expect(handlers.onReturn).toHaveBeenCalledOnce();

    // The caller is gone, so a sheet that finishes later must not refresh.
    controller.abort();
    pending.resolve({ type: 'cancel' });
    await flushMicrotasks();
    expect(handlers.onReturn).toHaveBeenCalledOnce();
  });

  it('does not surface a rejecting late refresh', async () => {
    mocks.appState.currentState = 'active';
    const pending = pendingLaunch();
    const handlers = returnHandlers();
    const launch = launchConnectGateBrowser('https://example.com/connect', handlers);
    emitAppState('background');
    emitAppState('active');
    await launch;
    handlers.onReturn.mockRejectedValueOnce(new Error('status refetch failed'));

    // A rejecting read is the query's own state to report; an unhandled
    // rejection here would fail this test.
    pending.resolve({ type: 'cancel' });
    await vi.waitFor(() => {
      expect(handlers.onReturn).toHaveBeenCalledTimes(2);
    });
    await flushMicrotasks();
  });
});

describe('launchConnectGateBrowser', () => {
  it('propagates refetch errors without misreporting a browser-launch failure', async () => {
    mocks.platform.OS = 'ios';
    mocks.openAuthSessionAsync.mockResolvedValue({ type: 'dismiss' });
    const error = new Error('status refetch failed');
    const handlers = { onReturn: vi.fn().mockRejectedValue(error), onOpenFailure: vi.fn() };

    await expect(launchConnectGateBrowser('https://example.com/connect', handlers)).rejects.toBe(
      error
    );
    expect(handlers.onOpenFailure).not.toHaveBeenCalled();
  });
});

describe('openAuthorizationAndWaitForReturn', () => {
  it('propagates a launch failure to other authorization callers', async () => {
    mocks.platform.OS = 'ios';
    const error = new Error('no browser');
    mocks.openAuthSessionAsync.mockRejectedValue(error);

    await expect(openAuthorizationAndWaitForReturn('https://example.com/connect')).rejects.toBe(
      error
    );
  });
});
