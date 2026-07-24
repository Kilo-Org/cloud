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
