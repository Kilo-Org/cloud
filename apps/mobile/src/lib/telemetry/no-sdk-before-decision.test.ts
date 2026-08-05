import { describe, expect, it, vi } from 'vitest';

// Static import of the mobile package manifest — no file-system walk.
import pkg from '../../../package.json';

// ---- shared hoisted mocks ----

const hoisted = vi.hoisted(() => {
  const client = {
    register: vi.fn(),
    setPersonPropertiesForFlags: vi.fn(),
    onFeatureFlags: vi.fn(),
    capture: vi.fn(),
    screen: vi.fn(),
    identify: vi.fn(),
    reloadFeatureFlags: vi.fn(),
    getFeatureFlag: vi.fn(),
    reset: vi.fn(),
    setPersistedProperty: vi.fn(),
    optOut: vi.fn().mockResolvedValue(undefined),
  };

  const appsFlyer = {
    initSdk: vi.fn(),
    logEvent: vi.fn(),
    stop: vi.fn(),
    create: vi.fn(),
    startObservingTransactions: vi.fn(),
    stopObservingTransactions: vi.fn(),
  };

  const device = { deviceType: null as number | null };

  let sealedState = false;
  const storage = {
    sealPostHogStorage: vi.fn().mockImplementation(() => {
      sealedState = true;
    }),
    unsealPostHogStorage: vi.fn().mockImplementation(() => {
      sealedState = false;
    }),
    purgePostHogPersistence: vi.fn(),
    isPostHogStorageSealed: vi.fn().mockImplementation(() => sealedState),
    // oxlint-disable-next-line consistent-type-assertions -- mock must match PostHogCustomStorage interface
    posthogCustomStorage: {} as Record<string, unknown>,
  };

  // Fresh controller — no decision set.
  const controller = {
    allowsOptional: vi.fn().mockReturnValue(false),
    currentGeneration: vi.fn().mockReturnValue(0),
  };

  return { client, appsFlyer, device, storage, controller };
});

// ---- vi.mock calls ----

vi.mock('posthog-react-native', () => ({
  default: vi.fn(() => hoisted.client),
  PostHogPersistedProperty: {
    Queue: 'queue',
    LogsQueue: 'logs_queue',
    AiQueue: 'ai_queue',
  },
}));

vi.mock('expo-device', () => ({
  DeviceType: { UNKNOWN: 0, PHONE: 1, TABLET: 2, DESKTOP: 3, TV: 4 },
  get deviceType() {
    return hoisted.device.deviceType;
  },
}));

vi.mock('expo-application', () => ({
  nativeApplicationVersion: '1.2.3',
  nativeBuildVersion: '45',
}));

vi.mock('expo-file-system', () => ({
  File: {},
  Paths: {},
}));

vi.mock('@/lib/config', () => ({
  POSTHOG_API_KEY: 'test-key',
  APPSFLYER_DEV_KEY: 'dev-key',
  APPSFLYER_APP_ID: 'app-id',
}));

vi.mock('@/lib/telemetry/controller', () => ({
  allowsOptional: hoisted.controller.allowsOptional,
  currentGeneration: hoisted.controller.currentGeneration,
}));

vi.mock('@/lib/telemetry/posthog-storage', () => ({
  sealPostHogStorage: hoisted.storage.sealPostHogStorage,
  unsealPostHogStorage: hoisted.storage.unsealPostHogStorage,
  purgePostHogPersistence: hoisted.storage.purgePostHogPersistence,
  isPostHogStorageSealed: hoisted.storage.isPostHogStorageSealed,
  posthogCustomStorage: hoisted.storage.posthogCustomStorage,
}));

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));

vi.mock('react-native-appsflyer', () => ({
  default: {
    initSdk: hoisted.appsFlyer.initSdk,
    logEvent: hoisted.appsFlyer.logEvent,
    stop: hoisted.appsFlyer.stop,
  },
  AppsFlyerConsent: { NON_ANONYMIZED: 'nonAnonymized' },
  AppsFlyerPurchaseConnector: {
    create: hoisted.appsFlyer.create,
    startObservingTransactions: hoisted.appsFlyer.startObservingTransactions,
    stopObservingTransactions: hoisted.appsFlyer.stopObservingTransactions,
  },
  StoreKitVersion: { SK1: 'SK1', SK2: 'SK2' },
}));

vi.mock('@sentry/react-native', () => ({ captureException: vi.fn() }));

vi.stubGlobal('__DEV__', false);

// ---- loaders ----

// oxlint-disable-next-line require-await -- async required by promise-function-async
async function loadPostHogModule() {
  vi.resetModules();
  return import('../analytics/posthog');
}

// oxlint-disable-next-line require-await -- async required by promise-function-async
async function loadAppsFlyerModule() {
  vi.resetModules();
  return import('../appsflyer');
}

// ---- tests ----

describe('no SDK starts before a telemetry decision', () => {
  it('has no expo-insights in the mobile package dependencies', () => {
    expect((pkg as { name?: string }).name).toBe('kilo-app');
    const deps = (pkg as { dependencies?: Record<string, unknown> }).dependencies ?? {};
    expect(deps).not.toHaveProperty('expo-insights');
  });

  it('importing posthog does not construct PostHog', async () => {
    hoisted.controller.allowsOptional.mockReturnValue(false);
    hoisted.controller.currentGeneration.mockReturnValue(0);
    vi.clearAllMocks();

    await loadPostHogModule();

    const PostHogModule = await import('posthog-react-native');
    expect(PostHogModule.default).not.toHaveBeenCalled();
  });

  it('importing appsflyer does not call initSdk', async () => {
    hoisted.controller.allowsOptional.mockReturnValue(false);
    hoisted.controller.currentGeneration.mockReturnValue(0);
    vi.clearAllMocks();

    await loadAppsFlyerModule();

    expect(hoisted.appsFlyer.initSdk).not.toHaveBeenCalled();
  });

  it('initPostHog with a fresh controller does not construct PostHog', async () => {
    hoisted.controller.allowsOptional.mockReturnValue(false);
    hoisted.controller.currentGeneration.mockReturnValue(0);
    vi.clearAllMocks();

    const posthog = await loadPostHogModule();
    posthog.initPostHog();

    const PostHogModule = await import('posthog-react-native');
    expect(PostHogModule.default).not.toHaveBeenCalled();
  });

  it('initAppsFlyer with a fresh controller does not call initSdk', async () => {
    hoisted.controller.allowsOptional.mockReturnValue(false);
    hoisted.controller.currentGeneration.mockReturnValue(0);
    vi.clearAllMocks();

    const appsflyer = await loadAppsFlyerModule();
    appsflyer.initAppsFlyer();

    expect(hoisted.appsFlyer.initSdk).not.toHaveBeenCalled();
  });

  it('trackEvent with a fresh controller does not call logEvent', async () => {
    hoisted.controller.allowsOptional.mockReturnValue(false);
    hoisted.controller.currentGeneration.mockReturnValue(0);
    vi.clearAllMocks();

    const appsflyer = await loadAppsFlyerModule();
    appsflyer.trackEvent('test-event');

    expect(hoisted.appsFlyer.logEvent).not.toHaveBeenCalled();
  });
});
