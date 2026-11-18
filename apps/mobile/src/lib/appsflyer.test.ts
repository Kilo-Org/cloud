// oxlint-disable max-lines — one coherent lifecycle/integration suite; splitting
// would duplicate the shared mock scaffold and weaken the causal ordering tests.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockedPlatform = vi.hoisted(() => ({ OS: 'ios' }));

const mockedAppsFlyer = vi.hoisted(() => ({
  init: vi.fn<() => Promise<void>>(),
  registerSessionReadyListener: vi.fn<(onReady: () => void) => Promise<void>>(),
  isSessionReady: vi.fn<() => Promise<boolean>>(),
  start: vi.fn<() => Promise<void>>(),
  stop: vi.fn<(params: { shouldStop: boolean }) => Promise<void>>(),
  setConsentData: vi.fn<(params: Record<string, unknown>) => Promise<void>>(),
  logEvent: vi.fn<(params: Record<string, unknown>) => Promise<void>>(),
  create: vi.fn<() => Promise<void>>(),
  startObservingTransactions: vi.fn(),
  stopObservingTransactions: vi.fn(),
}));

const mockedTracking = vi.hoisted(() => ({
  getTrackingPermissionsAsync: vi.fn<() => Promise<{ status: string }>>(),
}));

const mockedSentry = vi.hoisted(() => ({ captureException: vi.fn() }));

const mockedController = vi.hoisted(() => ({
  allowsOptional: vi.fn().mockReturnValue(true),
  currentGeneration: vi.fn().mockReturnValue(0),
}));

/** Session-ready callbacks the module registered, oldest first. */
const sessionReadyListeners = vi.hoisted((): (() => void)[] => []);

vi.mock('react-native', () => ({
  Platform: mockedPlatform,
}));

vi.mock('react-native-appsflyer', () => ({
  default: {
    init: mockedAppsFlyer.init,
    registerSessionReadyListener: mockedAppsFlyer.registerSessionReadyListener,
    isSessionReady: mockedAppsFlyer.isSessionReady,
    start: mockedAppsFlyer.start,
    stop: mockedAppsFlyer.stop,
    setConsentData: mockedAppsFlyer.setConsentData,
    logEvent: mockedAppsFlyer.logEvent,
  },
  AppsFlyerPurchaseConnector: {
    create: mockedAppsFlyer.create,
    startObservingTransactions: mockedAppsFlyer.startObservingTransactions,
    stopObservingTransactions: mockedAppsFlyer.stopObservingTransactions,
  },
  StoreKitVersion: { SK1: 'SK1', SK2: 'SK2' },
}));

vi.mock('expo-tracking-transparency', () => ({
  getTrackingPermissionsAsync: mockedTracking.getTrackingPermissionsAsync,
  PermissionStatus: { UNDETERMINED: 'undetermined', GRANTED: 'granted', DENIED: 'denied' },
}));

vi.mock('@sentry/react-native', () => ({ captureException: mockedSentry.captureException }));
vi.mock('@/lib/analytics/posthog', () => ({ captureEvent: vi.fn() }));
vi.mock('@/lib/config', () => ({
  APPSFLYER_DEV_KEY: 'dev-key',
  APPSFLYER_APP_ID: 'app-id',
}));
vi.mock('@/lib/telemetry/controller', () => ({
  allowsOptional: mockedController.allowsOptional,
  currentGeneration: mockedController.currentGeneration,
}));

vi.stubGlobal('__DEV__', false);

// A fresh module per test: the SDK state under test is module-level.
async function loadModule() {
  vi.resetModules();
  const module = await import('./appsflyer');
  return module;
}

/** Lets every queued promise continuation run, without advancing the clock. */
async function settle() {
  await vi.advanceTimersByTimeAsync(0);
}

/** Native reports the session ready as soon as the listener registers. */
function readyOnRegister() {
  // oxlint-disable-next-line require-await -- async required by promise-function-async
  mockedAppsFlyer.registerSessionReadyListener.mockImplementation(async onReady => {
    sessionReadyListeners.push(onReady);
    onReady();
  });
}

/** Native holds session-ready until the test fires it. */
function holdSessionReady() {
  // oxlint-disable-next-line require-await -- async required by promise-function-async
  mockedAppsFlyer.registerSessionReadyListener.mockImplementation(async onReady => {
    sessionReadyListeners.push(onReady);
  });
}

function fireSessionReady(index = sessionReadyListeners.length - 1) {
  sessionReadyListeners[index]?.();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  sessionReadyListeners.length = 0;
  mockedPlatform.OS = 'ios';
  mockedController.allowsOptional.mockReturnValue(true);
  mockedController.currentGeneration.mockReturnValue(0);
  mockedAppsFlyer.init.mockResolvedValue(undefined);
  mockedAppsFlyer.isSessionReady.mockResolvedValue(false);
  mockedAppsFlyer.start.mockResolvedValue(undefined);
  mockedAppsFlyer.stop.mockResolvedValue(undefined);
  mockedAppsFlyer.setConsentData.mockResolvedValue(undefined);
  mockedAppsFlyer.logEvent.mockResolvedValue(undefined);
  mockedAppsFlyer.create.mockResolvedValue(undefined);
  mockedTracking.getTrackingPermissionsAsync.mockResolvedValue({ status: 'granted' });
  readyOnRegister();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('initAppsFlyer startup', () => {
  it('starts the SDK once the session is ready and delivers events afterwards', async () => {
    holdSessionReady();
    const { initAppsFlyer, trackEvent } = await loadModule();

    initAppsFlyer();
    await settle();
    expect(mockedAppsFlyer.init).toHaveBeenCalledWith({ devKey: 'dev-key', appId: 'app-id' });
    expect(mockedAppsFlyer.start).not.toHaveBeenCalled();

    fireSessionReady();
    await settle();
    expect(mockedAppsFlyer.start).toHaveBeenCalledTimes(1);

    trackEvent('access-required-shown', { step: 'one' });
    await settle();
    expect(mockedAppsFlyer.logEvent).toHaveBeenCalledWith({
      eventName: 'access-required-shown',
      eventValues: { step: 'one' },
    });
  });

  it('starts once when the session is already ready and the event also fires', async () => {
    mockedAppsFlyer.isSessionReady.mockResolvedValue(true);
    holdSessionReady();
    const { initAppsFlyer } = await loadModule();

    initAppsFlyer();
    await settle();
    expect(mockedAppsFlyer.start).toHaveBeenCalledTimes(1);

    fireSessionReady();
    await settle();
    expect(mockedAppsFlyer.start).toHaveBeenCalledTimes(1);
  });

  it('holds start while the iOS tracking prompt is unanswered', async () => {
    mockedTracking.getTrackingPermissionsAsync
      .mockResolvedValueOnce({ status: 'undetermined' })
      .mockResolvedValue({ status: 'granted' });
    const { initAppsFlyer } = await loadModule();

    initAppsFlyer();
    await settle();
    expect(mockedAppsFlyer.start).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(250);
    expect(mockedAppsFlyer.start).toHaveBeenCalledTimes(1);
  });

  it('starts after 10 s when the tracking prompt stays unanswered', async () => {
    mockedTracking.getTrackingPermissionsAsync.mockResolvedValue({ status: 'undetermined' });
    const { initAppsFlyer } = await loadModule();

    initAppsFlyer();
    await vi.advanceTimersByTimeAsync(9000);
    expect(mockedAppsFlyer.start).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1500);
    expect(mockedAppsFlyer.start).toHaveBeenCalledTimes(1);
  });

  it('does not wait for the tracking prompt on Android', async () => {
    mockedPlatform.OS = 'android';
    const { initAppsFlyer } = await loadModule();

    initAppsFlyer();
    await settle();

    expect(mockedTracking.getTrackingPermissionsAsync).not.toHaveBeenCalled();
    expect(mockedAppsFlyer.start).toHaveBeenCalledTimes(1);
  });
});

describe('initAppsFlyer purchase connector', () => {
  it('creates the connector and observes transactions on iOS', async () => {
    const { initAppsFlyer } = await loadModule();

    initAppsFlyer();

    expect(mockedAppsFlyer.create).toHaveBeenCalledWith({
      logSubscriptions: true,
      logInApps: false,
      sandbox: false,
      storeKitVersion: 'SK2',
    });
    await settle();
    expect(mockedAppsFlyer.startObservingTransactions).toHaveBeenCalledTimes(1);
  });

  it('does not observe transactions before the SDK has started', async () => {
    holdSessionReady();
    const { initAppsFlyer } = await loadModule();

    initAppsFlyer();
    await settle();

    expect(mockedAppsFlyer.create).toHaveBeenCalledTimes(1);
    expect(mockedAppsFlyer.startObservingTransactions).not.toHaveBeenCalled();
  });

  it('does not observe transactions when create fails', async () => {
    mockedAppsFlyer.create.mockRejectedValue(new Error('native bridge down'));
    const { initAppsFlyer } = await loadModule();

    initAppsFlyer();
    await settle();

    expect(mockedAppsFlyer.start).toHaveBeenCalledTimes(1);
    expect(mockedAppsFlyer.startObservingTransactions).not.toHaveBeenCalled();
  });

  it('does not touch the purchase connector on Android', async () => {
    mockedPlatform.OS = 'android';
    const { initAppsFlyer } = await loadModule();

    initAppsFlyer();
    await settle();

    expect(mockedAppsFlyer.start).toHaveBeenCalledTimes(1);
    expect(mockedAppsFlyer.create).not.toHaveBeenCalled();
    expect(mockedAppsFlyer.startObservingTransactions).not.toHaveBeenCalled();
  });

  it('creates the connector only once when init is re-entered before start', async () => {
    holdSessionReady();
    const { initAppsFlyer } = await loadModule();

    initAppsFlyer();
    initAppsFlyer();
    await settle();
    expect(mockedAppsFlyer.create).toHaveBeenCalledTimes(1);
    expect(mockedAppsFlyer.startObservingTransactions).not.toHaveBeenCalled();

    fireSessionReady();
    await settle();
    initAppsFlyer();
    await settle();

    expect(mockedAppsFlyer.create).toHaveBeenCalledTimes(1);
    expect(mockedAppsFlyer.startObservingTransactions).toHaveBeenCalledTimes(1);
  });

  it('swallows the benign connector-already-configured rejection', async () => {
    mockedAppsFlyer.create.mockRejectedValue({
      code: 'Connector already configured',
      message: 'Connector already configured',
    });
    const { initAppsFlyer } = await loadModule();

    initAppsFlyer();
    await settle();

    expect(mockedSentry.captureException).not.toHaveBeenCalled();
    expect(mockedAppsFlyer.startObservingTransactions).toHaveBeenCalledTimes(1);
  });

  it('reports non-benign purchase connector failures to Sentry', async () => {
    mockedAppsFlyer.create.mockRejectedValue(new Error('native bridge down'));
    const { initAppsFlyer } = await loadModule();

    initAppsFlyer();
    await settle();

    expect(mockedSentry.captureException).toHaveBeenCalledTimes(1);
    expect(mockedSentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'AppsFlyer create-purchase-connector failed' }),
      {
        tags: {
          'error.subsystem': 'appsflyer',
          'error.operation': 'create-purchase-connector',
        },
        extra: { platform: 'ios' },
        fingerprint: ['appsflyer', 'create-purchase-connector'],
      }
    );
  });
});

const INIT_SDK_FAILURE = {
  tags: { 'error.subsystem': 'appsflyer', 'error.operation': 'init-sdk' },
  extra: { platform: 'ios' },
  fingerprint: ['appsflyer', 'init-sdk'],
};

describe('AppsFlyer error reporting', () => {
  it('does not report a logEvent failure to Sentry', async () => {
    mockedAppsFlyer.logEvent.mockRejectedValue(new Error('Failed to connect'));
    const { initAppsFlyer, trackEvent } = await loadModule();

    initAppsFlyer();
    await settle();
    trackEvent('access-required-shown');
    await settle();

    expect(mockedAppsFlyer.logEvent).toHaveBeenCalledTimes(1);
    expect(mockedSentry.captureException).not.toHaveBeenCalled();
  });

  it('does not report a queued-event failure when the queue drains', async () => {
    mockedAppsFlyer.logEvent.mockRejectedValue(new Error('Failed to connect'));
    const { initAppsFlyer, trackEvent } = await loadModule();

    trackEvent('access-required-shown');
    expect(mockedAppsFlyer.logEvent).not.toHaveBeenCalled();

    initAppsFlyer();
    await settle();

    expect(mockedAppsFlyer.logEvent).toHaveBeenCalledTimes(1);
    expect(mockedSentry.captureException).not.toHaveBeenCalled();
  });

  it('reports an SDK init failure to Sentry', async () => {
    mockedAppsFlyer.init.mockRejectedValue({ code: 400, message: 'Invalid dev key' });
    holdSessionReady();
    const { initAppsFlyer } = await loadModule();

    initAppsFlyer();
    await settle();

    expect(mockedSentry.captureException).toHaveBeenCalledTimes(1);
    expect(mockedSentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'AppsFlyer init-sdk failed' }),
      INIT_SDK_FAILURE
    );
  });

  it('reports a start failure to Sentry and keeps events queued', async () => {
    mockedAppsFlyer.start.mockRejectedValue({ code: 500, message: 'not initialized' });
    const { initAppsFlyer, trackEvent } = await loadModule();

    initAppsFlyer();
    await settle();
    trackEvent('post-failure-event');
    await settle();

    expect(mockedSentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'AppsFlyer init-sdk failed' }),
      INIT_SDK_FAILURE
    );
    expect(mockedAppsFlyer.logEvent).not.toHaveBeenCalled();
    expect(mockedAppsFlyer.startObservingTransactions).not.toHaveBeenCalled();
  });
});

describe('AppsFlyer gate', () => {
  it('does not call the SDK when optional consent is not given', async () => {
    mockedController.allowsOptional.mockReturnValue(false);
    const { initAppsFlyer } = await loadModule();

    initAppsFlyer();
    await settle();

    expect(mockedAppsFlyer.setConsentData).not.toHaveBeenCalled();
    expect(mockedAppsFlyer.init).not.toHaveBeenCalled();
    expect(mockedAppsFlyer.start).not.toHaveBeenCalled();
  });

  it('trackEvent returns early when optional consent is not given', async () => {
    mockedController.allowsOptional.mockReturnValue(false);
    const { trackEvent } = await loadModule();
    trackEvent('test-event');
    await settle();

    expect(mockedAppsFlyer.logEvent).not.toHaveBeenCalled();
  });

  it('trackEvent does not queue when optional consent is not given', async () => {
    mockedController.allowsOptional.mockReturnValue(false);
    const { trackEvent, initAppsFlyer } = await loadModule();
    trackEvent('test-event');

    // Turn on consent and init — nothing drains because nothing was queued.
    mockedController.allowsOptional.mockReturnValue(true);
    initAppsFlyer();
    await settle();

    expect(mockedAppsFlyer.start).toHaveBeenCalledTimes(1);
    expect(mockedAppsFlyer.logEvent).not.toHaveBeenCalled();
  });
});

describe('AppsFlyer consent', () => {
  it('sets consent and resumes the SDK before init', async () => {
    const consent = Promise.withResolvers<undefined>();
    mockedAppsFlyer.setConsentData.mockReturnValue(consent.promise);
    const { initAppsFlyer } = await loadModule();

    initAppsFlyer();
    await settle();
    expect(mockedAppsFlyer.setConsentData).toHaveBeenCalledTimes(1);
    expect(mockedAppsFlyer.init).not.toHaveBeenCalled();

    consent.resolve(undefined);
    await settle();
    expect(mockedAppsFlyer.stop).toHaveBeenCalledWith({ shouldStop: false });
    expect(mockedAppsFlyer.init).toHaveBeenCalledTimes(1);
    expect(mockedAppsFlyer.start).toHaveBeenCalledTimes(1);
  });

  it('still starts when setting consent fails', async () => {
    mockedAppsFlyer.setConsentData.mockRejectedValue(new Error('bridge down'));
    const { initAppsFlyer } = await loadModule();

    initAppsFlyer();
    await settle();

    expect(mockedAppsFlyer.start).toHaveBeenCalledTimes(1);
  });

  it('sends the given consent and does not claim GDPR is out of scope', async () => {
    const { initAppsFlyer } = await loadModule();

    initAppsFlyer();
    await settle();

    expect(mockedAppsFlyer.setConsentData).toHaveBeenCalledWith({
      isUserSubjectToGDPR: true,
      hasConsentForDataUsage: true,
      hasConsentForAdsPersonalization: true,
      hasConsentForAdStorage: true,
    });
  });

  it('re-sends consent and resumes after a reset when re-initing', async () => {
    const { initAppsFlyer, resetAppsFlyerState } = await loadModule();
    initAppsFlyer();
    await settle();

    resetAppsFlyerState();
    await settle();
    mockedAppsFlyer.setConsentData.mockClear();
    mockedAppsFlyer.stop.mockClear();
    mockedAppsFlyer.start.mockClear();

    initAppsFlyer();
    await settle();

    expect(mockedAppsFlyer.setConsentData).toHaveBeenCalledTimes(1);
    expect(mockedAppsFlyer.stop).toHaveBeenCalledWith({ shouldStop: false });
    expect(mockedAppsFlyer.start).toHaveBeenCalledTimes(1);
  });
});

describe('AppsFlyer generation scoping', () => {
  it('drops queued events from a stale generation', async () => {
    const module = await loadModule();
    module.trackEvent('gen0-event');

    // Bump generation before init drains the queue.
    mockedController.currentGeneration.mockReturnValue(1);
    module.initAppsFlyer();
    await settle();

    expect(mockedAppsFlyer.start).toHaveBeenCalledTimes(1);
    expect(mockedAppsFlyer.logEvent).not.toHaveBeenCalled();
  });
});

describe('resetAppsFlyerState', () => {
  it('stops native transmission', async () => {
    const { resetAppsFlyerState } = await loadModule();
    resetAppsFlyerState();
    await settle();

    expect(mockedAppsFlyer.stop).toHaveBeenCalledWith({ shouldStop: true });
  });

  it('stops only after an in-flight resume, so the revoke wins', async () => {
    const resume = Promise.withResolvers<undefined>();
    mockedAppsFlyer.stop.mockReturnValueOnce(resume.promise);
    holdSessionReady();
    const { initAppsFlyer, resetAppsFlyerState } = await loadModule();

    initAppsFlyer();
    await settle();
    expect(mockedAppsFlyer.stop).toHaveBeenCalledWith({ shouldStop: false });

    resetAppsFlyerState();
    await settle();
    expect(mockedAppsFlyer.stop).toHaveBeenCalledTimes(1);

    resume.resolve(undefined);
    await settle();
    expect(mockedAppsFlyer.stop).toHaveBeenLastCalledWith({ shouldStop: true });
    expect(mockedAppsFlyer.init).not.toHaveBeenCalled();
  });

  it('calls stopObservingTransactions on iOS after the connector was created', async () => {
    const { initAppsFlyer, resetAppsFlyerState } = await loadModule();
    initAppsFlyer();
    await settle();

    resetAppsFlyerState();
    await settle();

    expect(mockedAppsFlyer.stopObservingTransactions).toHaveBeenCalledTimes(1);
  });

  // Regression: a signed-out cold start resets before initAppsFlyer ever runs.
  // Native rejects with "Connector not configured, did you call `create`
  // first?" and the library drops that promise, so it reached Sentry as an
  // unhandled rejection.
  it('does not call stopObservingTransactions when the connector was never created', async () => {
    const { resetAppsFlyerState } = await loadModule();
    resetAppsFlyerState();
    await settle();

    expect(mockedAppsFlyer.stopObservingTransactions).not.toHaveBeenCalled();
  });

  it('does not call stopObservingTransactions on Android', async () => {
    mockedPlatform.OS = 'android';
    const { initAppsFlyer, resetAppsFlyerState } = await loadModule();
    initAppsFlyer();
    await settle();
    resetAppsFlyerState();
    await settle();

    expect(mockedAppsFlyer.stopObservingTransactions).not.toHaveBeenCalled();
  });

  it('invalidates JS state even when stop fails, blocking a stale session-ready', async () => {
    holdSessionReady();
    const module = await loadModule();
    module.initAppsFlyer();
    await settle();
    expect(sessionReadyListeners).toHaveLength(1);

    mockedAppsFlyer.stop.mockRejectedValue(new Error('native bridge down'));
    expect(() => {
      module.resetAppsFlyerState();
    }).not.toThrow();
    await settle();

    fireSessionReady(0);
    await settle();
    expect(mockedAppsFlyer.start).not.toHaveBeenCalled();
    expect(mockedAppsFlyer.startObservingTransactions).not.toHaveBeenCalled();

    // initialized stayed false, so the event buffers instead of sending.
    module.trackEvent('post-reset-event');
    await settle();
    expect(mockedAppsFlyer.logEvent).not.toHaveBeenCalled();
  });

  it('clears pending events so pre-reset events cannot drain on re-init', async () => {
    holdSessionReady();
    const module = await loadModule();
    module.initAppsFlyer();
    await settle();

    module.trackEvent('pre-reset-event');
    module.resetAppsFlyerState();
    await settle();

    fireSessionReady(0);
    await settle();
    expect(mockedAppsFlyer.logEvent).not.toHaveBeenCalled();

    readyOnRegister();
    module.initAppsFlyer();
    await settle();

    expect(mockedAppsFlyer.start).toHaveBeenCalledTimes(1);
    expect(mockedAppsFlyer.logEvent).not.toHaveBeenCalled();
  });

  it('does not arm the SDK when start resolves after a reset', async () => {
    const start = Promise.withResolvers<undefined>();
    mockedAppsFlyer.start.mockReturnValue(start.promise);
    const module = await loadModule();
    module.initAppsFlyer();
    await settle();
    expect(mockedAppsFlyer.start).toHaveBeenCalledTimes(1);

    module.resetAppsFlyerState();
    start.resolve(undefined);
    await settle();

    module.trackEvent('post-reset-event');
    await settle();
    expect(mockedAppsFlyer.logEvent).not.toHaveBeenCalled();
    expect(mockedAppsFlyer.startObservingTransactions).not.toHaveBeenCalled();
  });
});

describe('stale session-ready', () => {
  beforeEach(() => {
    holdSessionReady();
  });

  it('does not start or arm the SDK after a generation change', async () => {
    const module = await loadModule();
    module.initAppsFlyer();
    await settle();

    mockedController.currentGeneration.mockReturnValue(1);
    fireSessionReady();
    await settle();

    module.trackEvent('post-stale-event');
    await settle();
    expect(mockedAppsFlyer.start).not.toHaveBeenCalled();
    expect(mockedAppsFlyer.logEvent).not.toHaveBeenCalled();
    expect(mockedAppsFlyer.startObservingTransactions).not.toHaveBeenCalled();
  });

  it('does not drain buffered events after a generation change', async () => {
    const module = await loadModule();
    module.trackEvent('buffered-event');
    module.initAppsFlyer();
    await settle();

    mockedController.currentGeneration.mockReturnValue(1);
    fireSessionReady();
    await settle();

    expect(mockedAppsFlyer.logEvent).not.toHaveBeenCalled();
  });

  it('re-inits fully after a stale session-ready is ignored', async () => {
    const module = await loadModule();
    module.initAppsFlyer();
    await settle();

    mockedController.currentGeneration.mockReturnValue(1);
    fireSessionReady(0);
    await settle();
    expect(mockedAppsFlyer.start).not.toHaveBeenCalled();

    module.initAppsFlyer();
    await settle();
    expect(mockedAppsFlyer.init).toHaveBeenCalledTimes(2);

    fireSessionReady(1);
    await settle();
    expect(mockedAppsFlyer.start).toHaveBeenCalledTimes(1);
    expect(mockedAppsFlyer.startObservingTransactions).toHaveBeenCalledTimes(1);
  });

  it('ignores a session-ready that fires after a same-account reset', async () => {
    const module = await loadModule();
    module.trackEvent('buffered-event');
    module.initAppsFlyer();
    await settle();

    // Same-account optional revoke — generation unchanged.
    module.resetAppsFlyerState();
    fireSessionReady(0);
    await settle();

    module.trackEvent('post-reset-event');
    await settle();
    expect(mockedAppsFlyer.start).not.toHaveBeenCalled();
    expect(mockedAppsFlyer.logEvent).not.toHaveBeenCalled();
  });

  it('re-inits fully after a same-account reset', async () => {
    const module = await loadModule();
    module.initAppsFlyer();
    await settle();

    module.resetAppsFlyerState();
    fireSessionReady(0);
    await settle();
    expect(mockedAppsFlyer.start).not.toHaveBeenCalled();

    module.initAppsFlyer();
    await settle();
    fireSessionReady(1);
    await settle();

    expect(mockedAppsFlyer.start).toHaveBeenCalledTimes(1);
    expect(mockedAppsFlyer.startObservingTransactions).toHaveBeenCalledTimes(1);
  });
});
