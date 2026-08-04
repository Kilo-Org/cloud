/* oxlint-disable @typescript-eslint/no-unsafe-call @typescript-eslint/no-unsafe-member-access */
// oxlint-disable max-lines — gate teardown proof adds one mounted-hook test alongside existing module-level tests
// oxlint-disable typescript-eslint/no-deprecated — react-test-renderer is the DOM-free renderer for RN trees under vitest (node env, no jsdom); the React 19 deprecation points to DOM-based Testing Library, which cannot render this app's non-DOM tree
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---- single shared hoisted mock shape ----

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
  const holder: { options?: Record<string, unknown> } = {};

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
    // oxlint-disable-next-line consistent-type-assertions
    posthogCustomStorage: {} as Record<string, unknown>,
  };

  const device = { deviceType: null as number | null };

  const appsFlyer = {
    initSdk: vi.fn(),
    logEvent: vi.fn(),
    stop: vi.fn(),
    setConsentData: vi.fn(),
    create: vi.fn(),
    startObservingTransactions: vi.fn(),
    stopObservingTransactions: vi.fn(),
  };

  return { client, holder, storage, device, appsFlyer };
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

vi.mock('@/lib/config', () => ({
  APPSFLYER_DEV_KEY: 'dev-key',
  APPSFLYER_APP_ID: 'app-id',
  POSTHOG_API_KEY: 'test-key',
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
    setConsentData: hoisted.appsFlyer.setConsentData,
  },
  // oxlint-disable-next-line func-names max-params
  AppsFlyerConsent: vi.fn(function (
    this: Record<string, unknown>,
    isUserSubjectToGDPR?: boolean,
    hasConsentForDataUsage?: boolean,
    hasConsentForAdsPersonalization?: boolean,
    hasConsentForAdStorage?: boolean
  ) {
    this.isUserSubjectToGDPR = isUserSubjectToGDPR;
    this.hasConsentForDataUsage = hasConsentForDataUsage;
    this.hasConsentForAdsPersonalization = hasConsentForAdsPersonalization;
    this.hasConsentForAdStorage = hasConsentForAdStorage;
  }),
  AppsFlyerPurchaseConnector: {
    create: hoisted.appsFlyer.create,
    startObservingTransactions: hoisted.appsFlyer.startObservingTransactions,
    stopObservingTransactions: hoisted.appsFlyer.stopObservingTransactions,
  },
  StoreKitVersion: { SK1: 'SK1', SK2: 'SK2' },
}));

vi.mock('@sentry/react-native', () => ({ captureException: vi.fn() }));

vi.stubGlobal('__DEV__', false);

// ---- shared loaders ----

// oxlint-disable-next-line require-await -- async required by promise-function-async
async function loadPostHogModule() {
  vi.resetModules();
  return import('@/lib/analytics/posthog');
}

/** Load posthog, the gate helpers, and the controller from a single
 *  module registry so production gate helpers and SDK modules share
 *  the same controller instance. */
// oxlint-disable-next-line require-await -- async required by promise-function-async
async function loadPostHogWithGate() {
  vi.resetModules();
  const posthog = await import('@/lib/analytics/posthog');
  const gate = await import('@/lib/hooks/use-analytics-consent-gate');
  const ctrl = await import('@/lib/telemetry/controller');
  return { ...posthog, ...gate, ctrl };
}

/** Load appsflyer, the gate helpers, and the controller from a single
 *  module registry.  Used by the AppsFlyer buffer-isolation test. */
// oxlint-disable-next-line require-await -- async required by promise-function-async
async function loadAppsFlyerWithGate() {
  vi.resetModules();
  const appsflyer = await import('../appsflyer');
  const gate = await import('@/lib/hooks/use-analytics-consent-gate');
  const ctrl = await import('@/lib/telemetry/controller');
  return { ...appsflyer, ...gate, ctrl };
}

// ---- AppsFlyer buffer test ----

describe('buffer isolation between accounts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.appsFlyer.create.mockResolvedValue(undefined);
    hoisted.holder.options = undefined;
    hoisted.device.deviceType = 1;
  });

  it('drops account A buffered events after switch to account B', async () => {
    vi.useFakeTimers();

    const mod = await loadAppsFlyerWithGate();

    // 1. Start optional telemetry for account A.
    mod.ctrl.setTelemetryDecision('account-a', true);
    const epochA = mod.ctrl.currentEpoch();

    // Stall initSdk — initialized stays false.
    hoisted.appsFlyer.initSdk.mockImplementation(() => {
      // deliberate no-op
    });

    const startA = mod.startOptionalTelemetry(epochA, 'account-a@test.com');
    // resumePostHog has a 110 ms timer.
    await vi.advanceTimersByTimeAsync(110);
    await startA;

    // 2. Buffer a login event while init is stalled.
    mod.trackEvent('login');
    expect(hoisted.appsFlyer.logEvent).not.toHaveBeenCalled();

    // 3. Switch to account B — bump generation via clear + set.
    mod.ctrl.clearTelemetryDecision();
    mod.ctrl.setTelemetryDecision('account-b', true);
    const epochB = mod.ctrl.currentEpoch();

    // 4. Let initSdk succeed for account B and track the callback.
    let accountBOnSuccessCalled = false;
    hoisted.appsFlyer.initSdk.mockImplementation(
      (_options: unknown, onSuccess: (result: string) => void) => {
        onSuccess('ok');
        accountBOnSuccessCalled = true;
      }
    );

    const startB = mod.startOptionalTelemetry(epochB, 'account-b@test.com');
    await vi.advanceTimersByTimeAsync(110);
    await startB;

    // 5. Prove account B's drain path ran (init callback fired).
    expect(accountBOnSuccessCalled).toBe(true);

    // 6. Account A's buffered event must not drain.
    expect(hoisted.appsFlyer.logEvent).toHaveBeenCalledTimes(0);

    vi.useRealTimers();
  });
});

// ---- PostHog discard boundary tests ----

describe('discard closes capture', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.holder.options = undefined;
    hoisted.client.optOut.mockResolvedValue(undefined);
    hoisted.device.deviceType = 1;
  });

  it('captureEvent is a no-op after discardPostHog clears the client', async () => {
    const { initPostHog, discardPostHog, captureEvent } = await loadPostHogModule();
    const ctrl = await import('@/lib/telemetry/controller');
    ctrl.setTelemetryDecision('test', true);
    initPostHog();
    await discardPostHog();

    captureEvent('test-event');
    expect(hoisted.client.capture).not.toHaveBeenCalled();
  });

  it('captureScreen and identifyUser are no-ops after discard', async () => {
    const { initPostHog, discardPostHog, captureScreen, identifyUser } = await loadPostHogModule();
    const ctrl = await import('@/lib/telemetry/controller');
    ctrl.setTelemetryDecision('test', true);
    initPostHog();
    await discardPostHog();

    captureScreen('test-screen');
    identifyUser('test@test.com');

    expect(hoisted.client.screen).not.toHaveBeenCalled();
    expect(hoisted.client.identify).not.toHaveBeenCalled();
  });

  it('captureEvent is a no-op when allowsOptional returns false', async () => {
    const { initPostHog, captureEvent } = await loadPostHogModule();
    const ctrl = await import('@/lib/telemetry/controller');
    ctrl.setTelemetryDecision('test', false);
    // initPostHog returns early — optional is false.
    initPostHog();

    captureEvent('test-event');
    expect(hoisted.client.capture).not.toHaveBeenCalled();
  });
});

// ---- optional telemetry lifecycle ----

describe('optional telemetry lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.holder.options = undefined;
    hoisted.device.deviceType = 1;
  });

  it('skips purge when a newer decision lands during discard', async () => {
    const mod = await loadPostHogWithGate();
    mod.ctrl.setTelemetryDecision('test', true);
    mod.initPostHog();

    // Switch to optional=false — same account, generation stays.
    mod.ctrl.setTelemetryDecision('test', false);
    const epoch = mod.ctrl.currentEpoch();

    // Stall optOut so the epoch can change before it resolves.
    let optOutResolve: (() => void) | undefined = undefined;
    hoisted.client.optOut.mockImplementationOnce(
      // oxlint-disable-next-line @typescript-eslint/promise-function-async -- mock returns pending promise
      () =>
        new Promise<void>(resolve => {
          optOutResolve = resolve;
        })
    );

    // discardOptionalTelemetry calls discardPostHog() internally — let it
    // await the stalled optOut while we bump the epoch.
    const optionalOff = mod.discardOptionalTelemetry(epoch);

    // Let the synchronous part of discardPostHog run (seal, clear queues,
    // client=null) so the stalled optOut is now the only pending work.
    await new Promise<void>(resolve => {
      void setTimeout(resolve, 0);
    });

    // Bump the epoch while the production helper has yielded after await.
    mod.ctrl.clearTelemetryDecision();

    // oxlint-disable-next-line @typescript-eslint/no-non-null-assertion -- resolver assigned synchronously
    optOutResolve!();
    await optionalOff;

    expect(hoisted.storage.purgePostHogPersistence).not.toHaveBeenCalled();
  });

  it('purges when the epoch remains unchanged after discard', async () => {
    const mod = await loadPostHogWithGate();
    mod.ctrl.setTelemetryDecision('test', true);
    mod.initPostHog();

    // Switch to optional=false.
    mod.ctrl.setTelemetryDecision('test', false);
    const epoch = mod.ctrl.currentEpoch();

    // discardOptionalTelemetry calls the real discardPostHog, which calls
    // optOut (mockResolvedValue) → resolves → checks epoch → matches → purges.
    await mod.discardOptionalTelemetry(epoch);

    expect(hoisted.storage.purgePostHogPersistence).toHaveBeenCalledTimes(1);
  });

  it('does not initialize SDKs when resume is superseded', async () => {
    const mod = await loadPostHogWithGate();
    vi.useFakeTimers();

    mod.ctrl.setTelemetryDecision('test', true);
    const epoch = mod.ctrl.currentEpoch();

    // Bump the epoch — newer decision supersedes the one epoch was captured for.
    mod.ctrl.setTelemetryDecision('test', false);

    const startPromise = mod.startOptionalTelemetry(epoch, 'test@example.com');

    // resumePostHog has a 110 ms timer. Advance past it so startOptionalTelemetry
    // can reach the epoch check.
    await vi.advanceTimersByTimeAsync(110);
    await startPromise;

    // Epoch mismatch → initAppsFlyer, initPostHog, identifyUser never called.
    expect(hoisted.holder.options).toBeUndefined();
    expect(hoisted.appsFlyer.initSdk).not.toHaveBeenCalled();

    vi.useRealTimers();
  });
});

// ---- needsConsent gate teardown ----

describe('needsConsent gate teardown', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.holder.options = undefined;
    hoisted.device.deviceType = 1;
    hoisted.appsFlyer.create.mockResolvedValue(undefined);
    hoisted.appsFlyer.initSdk.mockImplementation(
      (_options: unknown, onSuccess: (result: string) => void) => {
        onSuccess('ok');
      }
    );
  });

  it('resets AppsFlyer and discards PostHog when consent is invalidated', async () => {
    // Load gate + posthog + controller in one module registry.
    const mod = await loadPostHogWithGate();
    // Also load appsflyer in the same registry so controller is shared.
    const appsflyerMod = await import('../appsflyer');

    // Set up active optional decision with initialized state.
    mod.ctrl.setTelemetryDecision('test-account', true);
    mod.initPostHog();
    appsflyerMod.initAppsFlyer();
    expect(hoisted.appsFlyer.initSdk).toHaveBeenCalledTimes(1);

    // Simulate consent invalidation while signed in — same sequence the gate
    // hook now runs for needsConsent.
    mod.ctrl.setTelemetryDecision('test-account', false);
    const epoch = mod.ctrl.currentEpoch();

    // Controller write is synchronous, teardown follows.
    appsflyerMod.resetAppsFlyerState();
    expect(hoisted.appsFlyer.stop).toHaveBeenCalledWith(true);

    // PostHog discard initiated (not awaited).
    await mod.discardOptionalTelemetry(epoch);

    // sealPostHogStorage called synchronously inside discardPostHog.
    expect(hoisted.storage.sealPostHogStorage).toHaveBeenCalledTimes(1);
    // optOut called as part of the discard.
    expect(hoisted.client.optOut).toHaveBeenCalled();
    // purgePostHogPersistence called after discard because epoch matched.
    expect(hoisted.storage.purgePostHogPersistence).toHaveBeenCalledTimes(1);
  });

  it('gate hook tears down AppsFlyer and PostHog when needsConsent becomes true', async () => {
    const gate = await loadPostHogWithGate();

    // Arm telemetry first so the PostHog client exists when teardown runs.
    gate.ctrl.setTelemetryDecision('test-account', true);
    gate.initPostHog();

    // Define a wrapper that drives the gate hook with the supplied state.
    type GateState = Parameters<typeof gate.useAnalyticsConsentGate>[0];
    function GateWrapper(props: GateState): null {
      gate.useAnalyticsConsentGate(props);
      return null;
    }

    // Mount with needsConsent=true while signed in — must trigger full teardown.
    // Wrap in act so React flushes the useEffect synchronously.
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(GateWrapper, {
          hasToken: true,
          consentChecked: true,
          needsConsent: true,
          email: 'test@test.com',
          accountId: 'test-account',
          optionalConsent: true,
        })
      );
      // Flush microtasks so effects scheduled inside act settle.
      await Promise.resolve();
    });

    // The gate writes the controller decision synchronously.
    expect(gate.ctrl.allowsOptional()).toBe(false);

    // resetAppsFlyerState must be called — proves the needsConsent branch.
    expect(hoisted.appsFlyer.stop).toHaveBeenCalledWith(true);

    // discardPostHog runs sealPostHogStorage synchronously.
    expect(hoisted.storage.sealPostHogStorage).toHaveBeenCalledTimes(1);

    // Flush the async discard chain (optOut is mockResolvedValue).
    // Two flushes: one for optOut resolution, one for the chained
    // discardOptionalTelemetry to reach the epoch check + purge.
    await Promise.resolve();
    await Promise.resolve();

    expect(hoisted.client.optOut).toHaveBeenCalled();
    expect(hoisted.storage.purgePostHogPersistence).toHaveBeenCalledTimes(1);

    // Unmount the renderer so effects and subscriptions are torn down.
    renderer!.unmount();
  });
});
