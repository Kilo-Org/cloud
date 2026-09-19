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
  subscriptions: [] as {
    remove: ReturnType<typeof vi.fn>;
    listener: (state: string) => void;
  }[],
}));

vi.mock('react-native', () => ({
  Platform: mocks.platform,
  AppState: { addEventListener: mocks.addAppStateListener },
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
  mocks.addAppStateListener.mockImplementation(
    (_event: string, listener: (state: string) => void) => {
      const subscription = { remove: vi.fn(), listener };
      mocks.subscriptions.push(subscription);
      return { remove: subscription.remove };
    }
  );
});

describe('iOS launch', () => {
  beforeEach(() => {
    mocks.platform.OS = 'ios';
  });

  it('opens the native auth session and refetches when it resolves', async () => {
    mocks.openAuthSessionAsync.mockResolvedValue({ type: 'cancel' });
    const handlers = { onReturn: vi.fn().mockResolvedValue(undefined), onOpenFailure: vi.fn() };

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
    const handlers = { onReturn: vi.fn().mockResolvedValue(undefined), onOpenFailure: vi.fn() };

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
    const handlers = { onReturn: vi.fn().mockResolvedValue(undefined), onOpenFailure: vi.fn() };

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
      const open = os === 'android' ? mocks.openBrowserAsync : mocks.openAuthSessionAsync;
      open.mockRejectedValue(new Error('no browser'));
    } else {
      mocks.openBrowserAsync.mockResolvedValue({ type: 'opened' });
      mocks.openAuthSessionAsync.mockResolvedValue({ type: 'cancel' });
    }

    const launch = launchConnectGateBrowser('https://example.com/connect', handlers);
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
