import { describe, expect, it, vi } from 'vitest';

// Static import of the mobile package manifest — no file-system walk.
import pkg from '../../../package.json';

// The helper's vi.hoisted object merges into file scope. This suite closes
// both controller gates to `false`, preserving its "no SDK before a decision"
// default, while `device` and `appsFlyer` stay file-local doubles.
import {
  createControllerDouble,
  posthogMockConstructor,
  postHogPersistedProperty,
  posthogTestDouble,
} from '../analytics/posthog-test-double';

vi.mock('posthog-react-native', () => ({
  default: posthogMockConstructor,
  PostHogPersistedProperty: postHogPersistedProperty,
}));

vi.mock('expo-device', () => ({
  DeviceType: { UNKNOWN: 0, PHONE: 1, TABLET: 2, DESKTOP: 3, TV: 4 },
  get deviceType() {
    return device.deviceType;
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
  allowsMandatory: hoisted.controller.allowsMandatory,
  allowsOptional: hoisted.controller.allowsOptional,
  currentGeneration: hoisted.controller.currentGeneration,
}));

vi.mock('@/lib/telemetry/posthog-storage', () => ({
  sealPostHogStorage: hoisted.storage.sealPostHogStorage,
  unsealPostHogStorage: hoisted.storage.unsealPostHogStorage,
  purgePostHogPersistence: hoisted.storage.purgePostHogPersistence,
  posthogCustomStorage: hoisted.storage.posthogCustomStorage,
}));

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));

const device = { deviceType: null as number | null };

const appsFlyer = {
  init: vi.fn(),
  setConsentData: vi.fn(),
  logEvent: vi.fn(),
  stop: vi.fn(),
  create: vi.fn(),
  startObservingTransactions: vi.fn(),
  stopObservingTransactions: vi.fn(),
};

// File-local doubles and the closed-gates controller join the shared double in
// one merge, so every `hoisted.<name>.*` reference keeps working and the
// shared double stays unmodified.
const hoisted = {
  ...posthogTestDouble,
  device,
  appsFlyer,
  controller: createControllerDouble({ mandatory: false, optional: false }),
};

vi.mock('react-native-appsflyer', () => ({
  default: {
    init: hoisted.appsFlyer.init,
    setConsentData: hoisted.appsFlyer.setConsentData,
    logEvent: hoisted.appsFlyer.logEvent,
    stop: hoisted.appsFlyer.stop,
  },
  AppsFlyerPurchaseConnector: {
    create: hoisted.appsFlyer.create,
    startObservingTransactions: hoisted.appsFlyer.startObservingTransactions,
    stopObservingTransactions: hoisted.appsFlyer.stopObservingTransactions,
  },
  StoreKitVersion: { SK1: 'SK1', SK2: 'SK2' },
}));

vi.mock('expo-tracking-transparency', () => ({
  getTrackingPermissionsAsync: vi.fn(),
  PermissionStatus: { UNDETERMINED: 'undetermined' },
}));

vi.mock('@sentry/react-native', () => ({ captureException: vi.fn() }));

vi.stubGlobal('__DEV__', false);

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

describe('no SDK starts before a telemetry decision', () => {
  it('has no expo-insights in the mobile package dependencies', () => {
    expect((pkg as { name?: string }).name).toBe('kilo-app');
    const deps = (pkg as { dependencies?: Record<string, unknown> }).dependencies ?? {};
    expect(deps).not.toHaveProperty('expo-insights');
  });

  it('importing posthog does not construct PostHog', async () => {
    hoisted.controller.allowsMandatory.mockReturnValue(false);
    hoisted.controller.allowsOptional.mockReturnValue(false);
    hoisted.controller.currentGeneration.mockReturnValue(0);
    vi.clearAllMocks();

    await loadPostHogModule();

    const PostHogModule = await import('posthog-react-native');
    expect(PostHogModule.default).not.toHaveBeenCalled();
  });

  it('importing appsflyer does not call the SDK', async () => {
    hoisted.controller.allowsOptional.mockReturnValue(false);
    hoisted.controller.currentGeneration.mockReturnValue(0);
    vi.clearAllMocks();

    await loadAppsFlyerModule();

    expect(hoisted.appsFlyer.setConsentData).not.toHaveBeenCalled();
    expect(hoisted.appsFlyer.init).not.toHaveBeenCalled();
  });

  it('initPostHog with a fresh controller does not construct PostHog', async () => {
    hoisted.controller.allowsMandatory.mockReturnValue(false);
    hoisted.controller.allowsOptional.mockReturnValue(false);
    hoisted.controller.currentGeneration.mockReturnValue(0);
    vi.clearAllMocks();

    const posthog = await loadPostHogModule();
    posthog.initPostHog();

    const PostHogModule = await import('posthog-react-native');
    expect(PostHogModule.default).not.toHaveBeenCalled();
  });

  it('initPostHog after the consent decision constructs a capture-free client', async () => {
    // The invariant is "no SDK before the decision", not "no SDK without
    // optional consent": a decided account still evaluates feature flags, with
    // every capture path closed.
    hoisted.controller.allowsMandatory.mockReturnValue(true);
    hoisted.controller.allowsOptional.mockReturnValue(false);
    hoisted.controller.currentGeneration.mockReturnValue(0);
    vi.clearAllMocks();

    const posthog = await loadPostHogModule();
    posthog.initPostHog();

    const PostHogModule = await import('posthog-react-native');
    expect(PostHogModule.default).toHaveBeenCalledTimes(1);
    expect(hoisted.client.capture).not.toHaveBeenCalled();
  });

  it('initAppsFlyer with a fresh controller does not call the SDK', async () => {
    hoisted.controller.allowsOptional.mockReturnValue(false);
    hoisted.controller.currentGeneration.mockReturnValue(0);
    vi.clearAllMocks();

    const appsflyer = await loadAppsFlyerModule();
    appsflyer.initAppsFlyer();

    // The gate returns before the connector is created or startup is queued.
    expect(hoisted.appsFlyer.create).not.toHaveBeenCalled();
    expect(hoisted.appsFlyer.setConsentData).not.toHaveBeenCalled();
    expect(hoisted.appsFlyer.init).not.toHaveBeenCalled();
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
