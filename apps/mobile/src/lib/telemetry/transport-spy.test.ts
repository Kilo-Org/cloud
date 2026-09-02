/* oxlint-disable max-lines -- one transport-spy suite per SDK; splitting would duplicate the shared mock scaffold */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type SentryInitExtras } from '@/lib/sentry-init';

// ---- shared hoisted mocks ----

const hoisted = vi.hoisted(() => {
  const usHost = 'https://us.i.posthog.com';

  const fetch = vi.fn();
  const flush = vi.fn().mockResolvedValue(undefined);

  // The PostHog client double: `capture` routes through the client's own
  // `fetch` (not the global fetch), mirroring the real SDK, so a fetch wrap
  // registered by `wrapPostHogFetchForTests` observes the transport.
  const client = {
    register: vi.fn(),
    setPersonPropertiesForFlags: vi.fn(),
    onFeatureFlags: vi.fn(),
    setPersistedProperty: vi.fn(),
    optOut: vi.fn().mockResolvedValue(undefined),
    fetch,
    flush,
    capture: vi.fn(function capture(this: { fetch: typeof fetch }, name: string) {
      this.fetch(`${usHost}/batch/`, {
        method: 'POST',
        body: JSON.stringify({ event: name }),
      });
    }),
  };

  const holder: { options?: Record<string, unknown> } = {};

  const device = { deviceType: null as number | null };

  const appsFlyer = {
    initSdk: vi.fn(),
    logEvent: vi.fn(),
    stop: vi.fn(),
    setConsentData: vi.fn(),
    create: vi.fn().mockResolvedValue(undefined),
    startObservingTransactions: vi.fn(),
    stopObservingTransactions: vi.fn(),
  };

  const platform = { OS: 'ios' };

  const sentryHolder: { initOptions?: Record<string, unknown> } = {};
  const mobileReplayIntegration = vi.fn();
  const deeplinkIntegration = vi.fn();
  const expoRouterIntegration = vi.fn(() => ({ name: 'expo-router-integration' }));

  const storage = {
    sealPostHogStorage: vi.fn(),
    unsealPostHogStorage: vi.fn(),
    purgePostHogPersistence: vi.fn(),
    // oxlint-disable-next-line consistent-type-assertions -- mock must match PostHogCustomStorage interface
    posthogCustomStorage: {} as Record<string, unknown>,
  };

  return {
    client,
    fetch,
    flush,
    usHost,
    holder,
    device,
    appsFlyer,
    platform,
    sentryHolder,
    mobileReplayIntegration,
    deeplinkIntegration,
    expoRouterIntegration,
    storage,
  };
});

// ---- all vi.mock calls at top level ----

vi.mock('posthog-react-native', () => ({
  default: vi.fn(function PostHogMock(_key: string, options: Record<string, unknown>) {
    hoisted.holder.options = options;
    return hoisted.client;
  }),
  PostHogPersistedProperty: {
    Queue: 'queue',
    LogsQueue: 'logs_queue',
    AiQueue: 'ai_queue',
  },
}));

vi.mock('expo-application', () => ({
  nativeApplicationVersion: '1.2.3',
  nativeBuildVersion: '45',
}));

vi.mock('expo-device', () => ({
  DeviceType: { UNKNOWN: 0, PHONE: 1, TABLET: 2, DESKTOP: 3, TV: 4 },
  get deviceType() {
    return hoisted.device.deviceType;
  },
}));

vi.mock('expo', () => ({
  isRunningInExpoGo: vi.fn(() => false),
}));

vi.mock('@/lib/config', () => ({
  APPSFLYER_DEV_KEY: 'dev-key',
  APPSFLYER_APP_ID: 'app-id',
  POSTHOG_API_KEY: 'test-key',
  SENTRY_ENVIRONMENT: 'test',
}));

vi.mock('@/lib/telemetry/posthog-storage', () => ({
  sealPostHogStorage: hoisted.storage.sealPostHogStorage,
  unsealPostHogStorage: hoisted.storage.unsealPostHogStorage,
  purgePostHogPersistence: hoisted.storage.purgePostHogPersistence,
  posthogCustomStorage: hoisted.storage.posthogCustomStorage,
}));

vi.mock('react-native', () => ({ Platform: hoisted.platform }));

vi.mock('react-native-appsflyer', () => ({
  default: {
    initSdk: hoisted.appsFlyer.initSdk,
    logEvent: hoisted.appsFlyer.logEvent,
    stop: hoisted.appsFlyer.stop,
    setConsentData: hoisted.appsFlyer.setConsentData,
  },
  // oxlint-disable-next-line func-names
  AppsFlyerConsent: vi.fn(function (
    this: Record<string, unknown>,
    ...args: (boolean | undefined)[]
  ) {
    this.isUserSubjectToGDPR = args[0];
    this.hasConsentForDataUsage = args[1];
    this.hasConsentForAdsPersonalization = args[2];
    this.hasConsentForAdStorage = args[3];
  }),
  AppsFlyerPurchaseConnector: {
    create: hoisted.appsFlyer.create,
    startObservingTransactions: hoisted.appsFlyer.startObservingTransactions,
    stopObservingTransactions: hoisted.appsFlyer.stopObservingTransactions,
  },
  StoreKitVersion: { SK1: 'SK1', SK2: 'SK2' },
}));

vi.mock('@sentry/react-native', () => ({
  init: vi.fn((options: Record<string, unknown>) => {
    hoisted.sentryHolder.initOptions = options;
  }),
  mobileReplayIntegration: hoisted.mobileReplayIntegration,
  deeplinkIntegration: hoisted.deeplinkIntegration,
  expoRouterIntegration: hoisted.expoRouterIntegration,
  setUser: vi.fn(),
  setTag: vi.fn(),
  captureException: vi.fn(),
}));

vi.stubGlobal('__DEV__', false);

// ---- loaders ----

// Load posthog + appsflyer + the real controller from one module registry so
// the SDK modules and the controller share a single decision/generation state.
// oxlint-disable-next-line require-await -- async required by promise-function-async
async function loadModules() {
  vi.resetModules();
  const posthog = await import('@/lib/analytics/posthog');
  const appsflyer = await import('@/lib/appsflyer');
  const ctrl = await import('@/lib/telemetry/controller');
  return { posthog, appsflyer, ctrl };
}

// oxlint-disable-next-line require-await -- async required by promise-function-async
async function loadSentryInit() {
  vi.resetModules();
  return import('@/lib/sentry-init');
}

// ---- PostHog transport ----

describe('PostHog transport spy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.holder.options = undefined;
    hoisted.device.deviceType = 1;
    hoisted.client.optOut.mockResolvedValue(undefined);
  });

  it('observes client fetch with the PostHog US host after init + capture of a catalog event', async () => {
    const { posthog, ctrl } = await loadModules();
    ctrl.setTelemetryDecision('acct', true);
    posthog.initPostHog();

    const fetchSpy = vi.fn();
    // oxlint-disable-next-line require-await -- async required by promise-function-async
    posthog.wrapPostHogFetchForTests(originalFetch => async (url, init) => {
      fetchSpy(url, init);
      return originalFetch(url, init);
    });

    posthog.captureEvent('session_created');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const firstUrl = fetchSpy.mock.calls[0]?.[0] as string;
    expect(firstUrl).toContain('us.i.posthog.com');
    const firstInit = fetchSpy.mock.calls[0]?.[1] as { body?: string };
    expect(firstInit.body).toBe(JSON.stringify({ event: 'session_created' }));
  });

  it('applies a wrap registered before init to the client created later', async () => {
    const { posthog, ctrl } = await loadModules();
    ctrl.setTelemetryDecision('acct', true);

    const fetchSpy = vi.fn();
    // oxlint-disable-next-line require-await -- async required by promise-function-async
    posthog.wrapPostHogFetchForTests(originalFetch => async (url, init) => {
      fetchSpy(url, init);
      return originalFetch(url, init);
    });

    posthog.initPostHog();
    posthog.captureEvent('session_created');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[0] as string).toContain('us.i.posthog.com');
  });

  it('does not fetch after clearTelemetryDecision closes the optional gate', async () => {
    const { posthog, ctrl } = await loadModules();
    ctrl.setTelemetryDecision('acct', true);
    posthog.initPostHog();

    const fetchSpy = vi.fn();
    // oxlint-disable-next-line require-await -- async required by promise-function-async
    posthog.wrapPostHogFetchForTests(originalFetch => async (url, init) => {
      fetchSpy(url, init);
      return originalFetch(url, init);
    });

    ctrl.clearTelemetryDecision();
    posthog.captureEvent('session_created');

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not fetch after discardPostHog', async () => {
    const { posthog, ctrl } = await loadModules();
    ctrl.setTelemetryDecision('acct', true);
    posthog.initPostHog();

    const fetchSpy = vi.fn();
    // oxlint-disable-next-line require-await -- async required by promise-function-async
    posthog.wrapPostHogFetchForTests(originalFetch => async (url, init) => {
      fetchSpy(url, init);
      return originalFetch(url, init);
    });

    await posthog.discardPostHog();
    posthog.captureEvent('session_created');

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fetches only while optional consent is allowed (consent on then off)', async () => {
    const { posthog, ctrl } = await loadModules();
    ctrl.setTelemetryDecision('acct', true);
    posthog.initPostHog();

    const fetchSpy = vi.fn();
    // oxlint-disable-next-line require-await -- async required by promise-function-async
    posthog.wrapPostHogFetchForTests(originalFetch => async (url, init) => {
      fetchSpy(url, init);
      return originalFetch(url, init);
    });

    posthog.captureEvent('session_created');
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    ctrl.setTelemetryDecision('acct', false);
    posthog.captureEvent('session_created');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

// ---- AppsFlyer transport ----

describe('AppsFlyer transport spy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.platform.OS = 'ios';
    hoisted.appsFlyer.create.mockResolvedValue(undefined);
    hoisted.appsFlyer.initSdk.mockImplementation(
      (_options: unknown, onSuccess: (result: string) => void) => {
        onSuccess('ok');
      }
    );
  });

  it('observes the logEvent transport after init + trackEvent', async () => {
    const { appsflyer, ctrl } = await loadModules();

    const logEventSpy = vi.fn();
    appsflyer.wrapAppsFlyerLogEventForTests(() => (name, values) => {
      logEventSpy(name, values);
    });

    ctrl.setTelemetryDecision('acct', true);
    appsflyer.initAppsFlyer();
    appsflyer.trackEvent('login');

    expect(logEventSpy).toHaveBeenCalledTimes(1);
    expect(logEventSpy).toHaveBeenCalledWith('login', {});
  });

  it('does not call the logEvent transport after optional consent turns false', async () => {
    const { appsflyer, ctrl } = await loadModules();

    const logEventSpy = vi.fn();
    appsflyer.wrapAppsFlyerLogEventForTests(() => (name, values) => {
      logEventSpy(name, values);
    });

    ctrl.setTelemetryDecision('acct', true);
    appsflyer.initAppsFlyer();

    ctrl.setTelemetryDecision('acct', false);
    appsflyer.trackEvent('login');

    expect(logEventSpy).not.toHaveBeenCalled();
  });

  it('drains a queued event through the logEvent transport after init completes', async () => {
    const { appsflyer, ctrl } = await loadModules();

    const logEventSpy = vi.fn();
    appsflyer.wrapAppsFlyerLogEventForTests(() => (name, values) => {
      logEventSpy(name, values);
    });

    ctrl.setTelemetryDecision('acct', true);
    // Queue before init: initialized is false, so the event is buffered.
    appsflyer.trackEvent('login');
    expect(logEventSpy).not.toHaveBeenCalled();

    // init fires the success callback synchronously, which drains the queue.
    appsflyer.initAppsFlyer();

    expect(logEventSpy).toHaveBeenCalledTimes(1);
    expect(logEventSpy).toHaveBeenCalledWith('login', {});
  });
});

// ---- Sentry transport ----

describe('Sentry transport spy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.sentryHolder.initOptions = undefined;
  });

  it('passes the transport factory into init and registers masked replay when consented', async () => {
    const { initSentry } = await loadSentryInit();
    const transportFactory = vi.fn(() => undefined) as unknown as SentryInitExtras['transport'];

    initSentry(true, { transport: transportFactory });

    expect(hoisted.sentryHolder.initOptions?.transport).toBe(transportFactory);
    expect(hoisted.mobileReplayIntegration).toHaveBeenCalledWith({
      maskAllText: true,
      maskAllImages: true,
      maskAllVectors: true,
    });
  });

  it('registers no replay and disables screenshots when optional consent is false', async () => {
    const { initSentry } = await loadSentryInit();

    initSentry(false);

    expect(hoisted.mobileReplayIntegration).not.toHaveBeenCalled();
    expect(hoisted.sentryHolder.initOptions?.attachScreenshot).toBe(false);
  });
});
