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
    expect(mocks.addAppStateListener).not.toHaveBeenCalled();
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
