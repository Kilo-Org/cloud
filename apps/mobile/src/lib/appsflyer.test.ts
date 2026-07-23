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
});
