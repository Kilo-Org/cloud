import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockedPlatform = vi.hoisted(() => ({ OS: 'ios' }));

const mockedAppsFlyer = vi.hoisted(() => ({
  initSdk: vi.fn(),
  logEvent: vi.fn(),
  create: vi.fn(),
  startObservingTransactions: vi.fn(),
}));

vi.mock('react-native', () => ({
  Platform: mockedPlatform,
}));

vi.mock('react-native-appsflyer', () => ({
  default: {
    initSdk: mockedAppsFlyer.initSdk,
    logEvent: mockedAppsFlyer.logEvent,
  },
  AppsFlyerPurchaseConnector: {
    create: mockedAppsFlyer.create,
    startObservingTransactions: mockedAppsFlyer.startObservingTransactions,
  },
  StoreKitVersion: { SK1: 'SK1', SK2: 'SK2' },
}));

vi.mock('@sentry/react-native', () => ({ captureException: vi.fn() }));
vi.mock('@/lib/analytics/posthog', () => ({ captureEvent: vi.fn() }));
vi.mock('@/lib/config', () => ({
  APPSFLYER_DEV_KEY: 'dev-key',
  APPSFLYER_APP_ID: 'app-id',
}));

vi.stubGlobal('__DEV__', false);

async function loadInit() {
  vi.resetModules();
  const module = await import('./appsflyer');
  return module.initAppsFlyer;
}

async function loadModule() {
  vi.resetModules();
  const module = await import('./appsflyer');
  return module;
}

describe('initAppsFlyer purchase connector', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Patched create returns a promise; default to resolved.
    mockedAppsFlyer.create.mockResolvedValue(undefined);
    // initSdk fires its success callback so startObservingTransactions runs.
    mockedAppsFlyer.initSdk.mockImplementation(
      (_options: unknown, onSuccess: (result: string) => void) => {
        onSuccess('ok');
      }
    );
  });

  it('creates the connector and observes transactions on iOS', async () => {
    mockedPlatform.OS = 'ios';
    const initAppsFlyer = await loadInit();

    initAppsFlyer();

    expect(mockedAppsFlyer.create).toHaveBeenCalledWith({
      logSubscriptions: true,
      logInApps: false,
      sandbox: false,
      storeKitVersion: 'SK2',
    });
    expect(mockedAppsFlyer.startObservingTransactions).toHaveBeenCalledTimes(1);
  });

  it('does not touch the purchase connector on Android', async () => {
    mockedPlatform.OS = 'android';
    const initAppsFlyer = await loadInit();

    initAppsFlyer();

    expect(mockedAppsFlyer.initSdk).toHaveBeenCalledTimes(1);
    expect(mockedAppsFlyer.create).not.toHaveBeenCalled();
    expect(mockedAppsFlyer.startObservingTransactions).not.toHaveBeenCalled();
  });

  it('creates the connector only once when init is re-entered before success', async () => {
    mockedPlatform.OS = 'ios';
    const successHolder: { current: ((result: string) => void) | undefined } = {
      current: undefined,
    };
    mockedAppsFlyer.initSdk.mockImplementation(
      (_options: unknown, success: (result: string) => void) => {
        successHolder.current = success;
      }
    );

    const initAppsFlyer = await loadInit();

    initAppsFlyer();
    initAppsFlyer();

    expect(mockedAppsFlyer.create).toHaveBeenCalledTimes(1);
    expect(mockedAppsFlyer.startObservingTransactions).not.toHaveBeenCalled();

    successHolder.current?.('ok');

    initAppsFlyer();

    expect(mockedAppsFlyer.create).toHaveBeenCalledTimes(1);
    expect(mockedAppsFlyer.startObservingTransactions).toHaveBeenCalledTimes(1);
  });

  it('swallows the benign connector-already-configured rejection', async () => {
    mockedPlatform.OS = 'ios';
    const Sentry = await import('@sentry/react-native');
    mockedAppsFlyer.create.mockRejectedValue({
      code: 'Connector already configured',
      message: 'Connector already configured',
    });

    const initAppsFlyer = await loadInit();
    initAppsFlyer();

    await vi.waitFor(() => {
      expect(mockedAppsFlyer.create).toHaveBeenCalledTimes(1);
    });
    // Flush the handled rejection microtask.
    await Promise.resolve();
    await Promise.resolve();

    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('reports non-benign purchase connector failures to Sentry', async () => {
    mockedPlatform.OS = 'ios';
    const Sentry = await import('@sentry/react-native');
    mockedAppsFlyer.create.mockRejectedValue(new Error('native bridge down'));

    const initAppsFlyer = await loadInit();
    initAppsFlyer();

    await vi.waitFor(() => {
      expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    });

    const captured = vi.mocked(Sentry.captureException).mock.calls[0]?.[0];
    expect(captured).toBeInstanceOf(Error);
    expect((captured as Error).message).toContain('AppsFlyer purchase connector failed');
    expect((captured as Error).message).toContain('native bridge down');
  });
});

// AppsFlyer's logEvent takes (name, values, onSuccess, onError); the error
// callback is the fourth argument, read positionally to stay under max-params.
function failLogEventTransport() {
  mockedAppsFlyer.logEvent.mockImplementation((...args: unknown[]) => {
    const onError = args[3] as (details: unknown) => void;
    onError('Failed to connect to fxvuzl.inapps.appsflyersdk.com/[::]:443');
  });
}

describe('AppsFlyer event reporting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedPlatform.OS = 'ios';
    mockedAppsFlyer.create.mockResolvedValue(undefined);
    mockedAppsFlyer.initSdk.mockImplementation(
      (_options: unknown, onSuccess: (result: string) => void) => {
        onSuccess('ok');
      }
    );
  });

  it('does not report a logEvent transport failure to Sentry', async () => {
    const Sentry = await import('@sentry/react-native');
    failLogEventTransport();

    const { initAppsFlyer, trackEvent } = await loadModule();
    initAppsFlyer();
    trackEvent('access-required-shown');

    expect(mockedAppsFlyer.logEvent).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('does not report a queued-event delivery failure when the queue drains', async () => {
    const Sentry = await import('@sentry/react-native');
    failLogEventTransport();

    const { initAppsFlyer, trackEvent } = await loadModule();
    trackEvent('access-required-shown');
    expect(mockedAppsFlyer.logEvent).not.toHaveBeenCalled();

    initAppsFlyer();

    expect(mockedAppsFlyer.logEvent).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('still reports an SDK init failure to Sentry', async () => {
    const Sentry = await import('@sentry/react-native');
    mockedAppsFlyer.initSdk.mockImplementation(
      (_options: unknown, _onSuccess: (result: string) => void, onError: (d: unknown) => void) => {
        onError('Invalid dev key');
      }
    );

    const { initAppsFlyer } = await loadModule();
    initAppsFlyer();

    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    const captured = vi.mocked(Sentry.captureException).mock.calls[0]?.[0];
    expect((captured as Error).message).toContain('AppsFlyer init failed');
    expect((captured as Error).message).toContain('Invalid dev key');
  });
});
