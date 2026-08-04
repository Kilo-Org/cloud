// oxlint-disable max-lines — one coherent lifecycle/integration suite; splitting
// would duplicate the shared mock scaffold and weaken the causal ordering tests.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockedPlatform = vi.hoisted(() => ({ OS: 'ios' }));

const mockedAppsFlyer = vi.hoisted(() => ({
  initSdk: vi.fn(),
  logEvent: vi.fn(),
  stop: vi.fn(),
  setConsentData: vi.fn(),
  create: vi.fn(),
  startObservingTransactions: vi.fn(),
  stopObservingTransactions: vi.fn(),
}));

const mockedController = vi.hoisted(() => ({
  allowsOptional: vi.fn().mockReturnValue(true),
  currentGeneration: vi.fn().mockReturnValue(0),
}));

vi.mock('react-native', () => ({
  Platform: mockedPlatform,
}));

// Named constructor mock satisfies func-names and keeps the parameter
// list under max-params via rest args while matching the real
// AppsFlyerConsent constructor shape.
function AppsFlyerConsentCtor(this: Record<string, unknown>, ...args: (boolean | undefined)[]) {
  this.isUserSubjectToGDPR = args[0];
  this.hasConsentForDataUsage = args[1];
  this.hasConsentForAdsPersonalization = args[2];
  this.hasConsentForAdStorage = args[3];
}

vi.mock('react-native-appsflyer', () => ({
  default: {
    initSdk: mockedAppsFlyer.initSdk,
    logEvent: mockedAppsFlyer.logEvent,
    stop: mockedAppsFlyer.stop,
    setConsentData: mockedAppsFlyer.setConsentData,
  },
  AppsFlyerConsent: vi.fn(AppsFlyerConsentCtor),
  AppsFlyerPurchaseConnector: {
    create: mockedAppsFlyer.create,
    startObservingTransactions: mockedAppsFlyer.startObservingTransactions,
    stopObservingTransactions: mockedAppsFlyer.stopObservingTransactions,
  },
  StoreKitVersion: { SK1: 'SK1', SK2: 'SK2' },
}));

vi.mock('@sentry/react-native', () => ({ captureException: vi.fn() }));
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
    mockedController.allowsOptional.mockReturnValue(true);
    mockedController.currentGeneration.mockReturnValue(0);
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
    mockedController.allowsOptional.mockReturnValue(true);
    mockedController.currentGeneration.mockReturnValue(0);
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

describe('AppsFlyer gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedPlatform.OS = 'ios';
    mockedAppsFlyer.create.mockResolvedValue(undefined);
    mockedAppsFlyer.initSdk.mockImplementation(
      (_options: unknown, onSuccess: (result: string) => void) => {
        onSuccess('ok');
      }
    );
    mockedController.currentGeneration.mockReturnValue(0);
  });

  it('initAppsFlyer returns early when optional consent is not given', async () => {
    mockedController.allowsOptional.mockReturnValue(false);
    const initAppsFlyer = await loadInit();
    initAppsFlyer();

    expect(mockedAppsFlyer.initSdk).not.toHaveBeenCalled();
  });

  it('trackEvent returns early when optional consent is not given', async () => {
    mockedController.allowsOptional.mockReturnValue(false);
    const { trackEvent } = await loadModule();
    trackEvent('test-event');

    expect(mockedAppsFlyer.logEvent).not.toHaveBeenCalled();
  });

  it('trackEvent does not queue when optional consent is not given', async () => {
    mockedController.allowsOptional.mockReturnValue(false);
    const { trackEvent, initAppsFlyer } = await loadModule();
    trackEvent('test-event');

    // Turn on consent and init — the event must not drain because nothing was queued.
    mockedController.allowsOptional.mockReturnValue(true);
    mockedController.currentGeneration.mockReturnValue(0);
    initAppsFlyer();

    expect(mockedAppsFlyer.logEvent).not.toHaveBeenCalled();
  });
});

describe('AppsFlyer consent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedPlatform.OS = 'ios';
    mockedController.allowsOptional.mockReturnValue(true);
    mockedController.currentGeneration.mockReturnValue(0);
    mockedAppsFlyer.create.mockResolvedValue(undefined);
    mockedAppsFlyer.initSdk.mockImplementation(
      (_options: unknown, onSuccess: (result: string) => void) => {
        onSuccess('ok');
      }
    );
  });

  it('calls setConsentData before initSdk', async () => {
    const initAppsFlyer = await loadInit();
    initAppsFlyer();

    const setConsentCallOrder = mockedAppsFlyer.setConsentData.mock.invocationCallOrder[0];
    const initSdkCallOrder = mockedAppsFlyer.initSdk.mock.invocationCallOrder[0];
    expect(setConsentCallOrder).toBeDefined();
    expect(initSdkCallOrder).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- guarded above
    expect(setConsentCallOrder!).toBeLessThan(initSdkCallOrder!);
  });

  it('sends consent values from allowsOptional', async () => {
    mockedController.allowsOptional.mockReturnValue(true);
    const initAppsFlyer = await loadInit();
    initAppsFlyer();

    expect(mockedAppsFlyer.setConsentData).toHaveBeenCalledTimes(1);
    const consentArg = mockedAppsFlyer.setConsentData.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(consentArg.isUserSubjectToGDPR).toBeUndefined();
    expect(consentArg.hasConsentForDataUsage).toBe(true);
    expect(consentArg.hasConsentForAdsPersonalization).toBe(true);
    expect(consentArg.hasConsentForAdStorage).toBe(true);
  });

  it('does not call the SDK when optional consent is not given', async () => {
    mockedController.allowsOptional.mockReturnValue(false);
    const initAppsFlyer = await loadInit();
    initAppsFlyer();

    // initAppsFlyer returns early when allowsOptional is false — the SDK is
    // never called, including setConsentData and initSdk.
    expect(mockedAppsFlyer.setConsentData).not.toHaveBeenCalled();
    expect(mockedAppsFlyer.initSdk).not.toHaveBeenCalled();
  });

  it('re-sends consent after reset when re-initing', async () => {
    const { initAppsFlyer, resetAppsFlyerState } = await loadModule();
    initAppsFlyer();
    expect(mockedAppsFlyer.setConsentData).toHaveBeenCalledTimes(1);

    resetAppsFlyerState();
    mockedAppsFlyer.setConsentData.mockClear();
    mockedAppsFlyer.stop.mockClear();
    mockedAppsFlyer.initSdk.mockClear();

    initAppsFlyer();
    expect(mockedAppsFlyer.setConsentData).toHaveBeenCalledTimes(1);
    expect(mockedAppsFlyer.stop).toHaveBeenCalledWith(false);
    expect(mockedAppsFlyer.initSdk).toHaveBeenCalledTimes(1);
  });
});

describe('AppsFlyer generation scoping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedPlatform.OS = 'ios';
    mockedController.allowsOptional.mockReturnValue(true);
    mockedController.currentGeneration.mockReturnValue(0);
    mockedAppsFlyer.create.mockResolvedValue(undefined);
  });

  it('drops queued events from a stale generation', async () => {
    mockedController.currentGeneration.mockReturnValue(0);
    mockedAppsFlyer.initSdk.mockImplementation(
      (_options: unknown, onSuccess: (result: string) => void) => {
        onSuccess('ok');
      }
    );

    const module = await loadModule();
    // Queue an event at generation 0.
    module.trackEvent('gen0-event');

    // Bump generation before init drains the queue.
    mockedController.currentGeneration.mockReturnValue(1);
    module.initAppsFlyer();

    // The queued gen0-event must be dropped; no logEvent call.
    expect(mockedAppsFlyer.logEvent).not.toHaveBeenCalled();
  });
});

describe('resetAppsFlyerState', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedPlatform.OS = 'ios';
    mockedController.allowsOptional.mockReturnValue(true);
    mockedController.currentGeneration.mockReturnValue(0);
    mockedAppsFlyer.create.mockResolvedValue(undefined);
    mockedAppsFlyer.initSdk.mockImplementation(
      (_options: unknown, onSuccess: (result: string) => void) => {
        onSuccess('ok');
      }
    );
  });

  it('calls stop(true) to stop native transmission', async () => {
    const { resetAppsFlyerState } = await loadModule();
    resetAppsFlyerState();

    expect(mockedAppsFlyer.stop).toHaveBeenCalledWith(true);
  });

  it('calls stopObservingTransactions on iOS', async () => {
    mockedPlatform.OS = 'ios';
    const { resetAppsFlyerState } = await loadModule();
    resetAppsFlyerState();

    expect(mockedAppsFlyer.stopObservingTransactions).toHaveBeenCalledTimes(1);
  });

  it('does not call stopObservingTransactions on Android', async () => {
    mockedPlatform.OS = 'android';
    const { resetAppsFlyerState } = await loadModule();
    resetAppsFlyerState();

    expect(mockedAppsFlyer.stopObservingTransactions).not.toHaveBeenCalled();
  });

  it('handles a bare mock without stop gracefully', async () => {
    const origStop = mockedAppsFlyer.stop;
    (mockedAppsFlyer as Record<string, unknown>).stop = undefined;

    const { resetAppsFlyerState } = await loadModule();
    expect(() => {
      resetAppsFlyerState();
    }).not.toThrow();

    (mockedAppsFlyer as Record<string, unknown>).stop = origStop;
  });

  it('re-init after reset calls setConsentData, then stop(false), then initSdk', async () => {
    const { initAppsFlyer, resetAppsFlyerState } = await loadModule();
    // Initial init.
    initAppsFlyer();

    resetAppsFlyerState();
    expect(mockedAppsFlyer.stop).toHaveBeenCalledWith(true);

    mockedAppsFlyer.setConsentData.mockClear();
    mockedAppsFlyer.stop.mockClear();
    mockedAppsFlyer.initSdk.mockClear();

    // Re-init after reset.
    initAppsFlyer();

    const setConsentOrder = mockedAppsFlyer.setConsentData.mock.invocationCallOrder[0];
    const stopOrder = mockedAppsFlyer.stop.mock.invocationCallOrder[0];
    const initSdkOrder = mockedAppsFlyer.initSdk.mock.invocationCallOrder[0];
    expect(setConsentOrder).toBeDefined();
    expect(stopOrder).toBeDefined();
    expect(initSdkOrder).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- guarded above
    expect(setConsentOrder!).toBeLessThan(stopOrder!);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- guarded above
    expect(stopOrder!).toBeLessThan(initSdkOrder!);
  });

  it('invalidates JS state even when stop throws, blocking stale callback', async () => {
    const successHolders: ((result: string) => void)[] = [];
    mockedAppsFlyer.initSdk.mockImplementation(
      (_options: unknown, onSuccess: (result: string) => void) => {
        successHolders.push(onSuccess);
      }
    );

    const module = await loadModule();
    module.initAppsFlyer();
    expect(successHolders).toHaveLength(1);

    // Make stop throw AFTER initAppsFlyer so the initial stop(false) in
    // initAppsFlyer succeeds. Only the stop(true) inside reset must throw.
    mockedAppsFlyer.stop.mockImplementation(() => {
      throw new Error('native bridge down');
    });

    // reset must not throw despite the native exception.
    expect(() => {
      module.resetAppsFlyerState();
    }).not.toThrow();

    // Fire the stale callback — must not re-arm the SDK.
    successHolders[0]?.('ok');
    expect(mockedAppsFlyer.startObservingTransactions).not.toHaveBeenCalled();

    // Track an event — must buffer, not log, because initialized was cleared.
    module.trackEvent('post-reset-event');
    expect(mockedAppsFlyer.logEvent).not.toHaveBeenCalled();

    // Clean up: reset the throwing mock so other tests are not affected.
    mockedAppsFlyer.stop.mockReset();
  });

  it('clears initialized and pending events', async () => {
    mockedController.currentGeneration.mockReturnValue(0);
    mockedAppsFlyer.initSdk.mockImplementation(
      (_options: unknown, onSuccess: (result: string) => void) => {
        onSuccess('ok');
      }
    );

    const module = await loadModule();
    module.initAppsFlyer();
    // Queue one event before reset.
    module.trackEvent('pre-reset-event');
    expect(mockedAppsFlyer.logEvent).toHaveBeenCalledTimes(1);

    module.resetAppsFlyerState();

    // After reset, trackEvent queues because initialized is false.
    // But reset also cleared pendingEvents, so the pre-reset event is gone.
    // initAppsFlyer again and verify no previous event drains.
    mockedAppsFlyer.logEvent.mockClear();
    module.initAppsFlyer();

    // The pre-reset event must not drain because pendingEvents was cleared.
    expect(mockedAppsFlyer.logEvent).not.toHaveBeenCalled();
  });
});

describe('stale initSdk callback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedPlatform.OS = 'ios';
    mockedController.allowsOptional.mockReturnValue(true);
    mockedController.currentGeneration.mockReturnValue(0);
    mockedAppsFlyer.create.mockResolvedValue(undefined);
  });

  it('does not set initialized when the callback fires after reset', async () => {
    const successHolders: ((result: string) => void)[] = [];
    mockedAppsFlyer.initSdk.mockImplementation(
      (_options: unknown, onSuccess: (result: string) => void) => {
        successHolders.push(onSuccess);
      }
    );

    const module = await loadModule();
    module.initAppsFlyer();
    expect(successHolders).toHaveLength(1);

    // Bump generation to simulate controller clear (signOut or reset).
    mockedController.currentGeneration.mockReturnValue(1);

    // Fire the stale callback — must be a no-op.
    successHolders[0]?.('ok');

    // initialized must still be false, so trackEvent queues instead of logging.
    module.trackEvent('post-stale-event');
    expect(mockedAppsFlyer.logEvent).not.toHaveBeenCalled();
    expect(mockedAppsFlyer.startObservingTransactions).not.toHaveBeenCalled();
  });

  it('does not drain buffered events when the callback fires after reset', async () => {
    const successHolders: ((result: string) => void)[] = [];
    mockedAppsFlyer.initSdk.mockImplementation(
      (_options: unknown, onSuccess: (result: string) => void) => {
        successHolders.push(onSuccess);
      }
    );

    const module = await loadModule();

    // Buffer an event while init is stalled.
    module.trackEvent('buffered-event');
    expect(mockedAppsFlyer.logEvent).not.toHaveBeenCalled();

    // Start the stalled init.
    module.initAppsFlyer();
    expect(successHolders).toHaveLength(1);

    // Bump generation before the callback fires.
    mockedController.currentGeneration.mockReturnValue(1);

    // Fire the stale callback — must not drain the buffered event.
    successHolders[0]?.('ok');

    expect(mockedAppsFlyer.logEvent).not.toHaveBeenCalled();
  });

  it('re-inits fully after a stale callback is ignored', async () => {
    const successHolders: ((result: string) => void)[] = [];
    mockedAppsFlyer.initSdk.mockImplementation(
      (_options: unknown, onSuccess: (result: string) => void) => {
        successHolders.push(onSuccess);
      }
    );

    const module = await loadModule();
    module.initAppsFlyer();
    expect(successHolders).toHaveLength(1);

    // Bump generation to invalidate the pending callback.
    mockedController.currentGeneration.mockReturnValue(1);

    // Fire the stale callback.
    successHolders[0]?.('ok');
    expect(mockedAppsFlyer.startObservingTransactions).not.toHaveBeenCalled();

    // Re-init — generation now matches the controller.
    mockedAppsFlyer.setConsentData.mockClear();
    mockedAppsFlyer.stop.mockClear();
    mockedAppsFlyer.startObservingTransactions.mockClear();

    module.initAppsFlyer();
    expect(mockedAppsFlyer.setConsentData).toHaveBeenCalledTimes(1);
    expect(mockedAppsFlyer.stop).toHaveBeenCalledWith(false);
    expect(mockedAppsFlyer.initSdk).toHaveBeenCalledTimes(2);

    // Fire the new callback.
    expect(successHolders).toHaveLength(2);
    successHolders[1]?.('ok');
    expect(mockedAppsFlyer.startObservingTransactions).toHaveBeenCalledTimes(1);
  });
});

describe('callback token revoke invalidation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedPlatform.OS = 'ios';
    mockedController.allowsOptional.mockReturnValue(true);
    mockedController.currentGeneration.mockReturnValue(0);
    mockedAppsFlyer.create.mockResolvedValue(undefined);
  });

  it('does not set initialized when callback fires after same-account reset', async () => {
    const successHolders: ((result: string) => void)[] = [];
    mockedAppsFlyer.initSdk.mockImplementation(
      (_options: unknown, onSuccess: (result: string) => void) => {
        successHolders.push(onSuccess);
      }
    );

    const module = await loadModule();
    module.initAppsFlyer();
    expect(successHolders).toHaveLength(1);

    // Same-account optional revoke — generation unchanged.
    mockedController.currentGeneration.mockReturnValue(0);
    module.resetAppsFlyerState();

    // Fire the stale callback — token mismatch must block it.
    successHolders[0]?.('ok');

    // Track an event — must buffer because initialized was not set.
    module.trackEvent('post-reset-event');
    expect(mockedAppsFlyer.logEvent).not.toHaveBeenCalled();
  });

  it('does not drain queued events when callback fires after same-account reset', async () => {
    const successHolders: ((result: string) => void)[] = [];
    mockedAppsFlyer.initSdk.mockImplementation(
      (_options: unknown, onSuccess: (result: string) => void) => {
        successHolders.push(onSuccess);
      }
    );

    const module = await loadModule();

    // Buffer an event while init is stalled.
    module.trackEvent('buffered-event');
    expect(mockedAppsFlyer.logEvent).not.toHaveBeenCalled();

    module.initAppsFlyer();
    expect(successHolders).toHaveLength(1);

    // Same-account optional revoke — generation unchanged.
    mockedController.currentGeneration.mockReturnValue(0);
    module.resetAppsFlyerState();

    // Fire the stale callback.
    successHolders[0]?.('ok');

    // The buffered event must not drain — token mismatch blocked drainPendingEvents.
    expect(mockedAppsFlyer.logEvent).not.toHaveBeenCalled();
  });

  it('re-inits fully after same-account reset invalidation', async () => {
    const successHolders: ((result: string) => void)[] = [];
    mockedAppsFlyer.initSdk.mockImplementation(
      (_options: unknown, onSuccess: (result: string) => void) => {
        successHolders.push(onSuccess);
      }
    );

    const module = await loadModule();
    module.initAppsFlyer();
    expect(successHolders).toHaveLength(1);

    // Same-account optional revoke — generation unchanged.
    mockedController.currentGeneration.mockReturnValue(0);
    module.resetAppsFlyerState();

    // Fire the stale callback.
    successHolders[0]?.('ok');
    expect(mockedAppsFlyer.startObservingTransactions).not.toHaveBeenCalled();

    // Re-init — token now matches because resetAppsFlyerState was already called.
    mockedAppsFlyer.setConsentData.mockClear();
    mockedAppsFlyer.stop.mockClear();
    mockedAppsFlyer.startObservingTransactions.mockClear();

    module.initAppsFlyer();
    expect(mockedAppsFlyer.setConsentData).toHaveBeenCalledTimes(1);
    expect(mockedAppsFlyer.stop).toHaveBeenCalledWith(false);
    expect(mockedAppsFlyer.initSdk).toHaveBeenCalledTimes(2);

    // Fire the new callback — token matches, must succeed.
    expect(successHolders).toHaveLength(2);
    successHolders[1]?.('ok');
    expect(mockedAppsFlyer.startObservingTransactions).toHaveBeenCalledTimes(1);
  });
});
