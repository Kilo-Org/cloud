import * as Sentry from '@sentry/react-native';
import { getTrackingPermissionsAsync, PermissionStatus } from 'expo-tracking-transparency';
import { Platform } from 'react-native';
import appsFlyer, { AppsFlyerPurchaseConnector, StoreKitVersion } from 'react-native-appsflyer';
import { z } from 'zod';

import { captureEvent } from '@/lib/analytics/posthog';
import { APPSFLYER_APP_ID, APPSFLYER_DEV_KEY } from '@/lib/config';
import { allowsOptional, currentGeneration } from '@/lib/telemetry/controller';

let initialized = false;
/**
 * Resolves to whether the native purchase connector is configured. Null until
 * `create()` is first called. See `createPurchaseConnector`.
 */
let connectorReady: Promise<boolean> | null = null;
/**
 * Invalidation token for an in-flight SDK startup. Incremented by
 * `resetAppsFlyerState()` so a late session-ready or start() after
 * stop/optional revoke cannot re-arm the SDK even when generation is unchanged.
 */
let callbackToken = 0;
type PendingEvent = {
  name: string;
  values: Record<string, string>;
  generation: number;
};
const pendingEvents: PendingEvent[] = [];

const CONNECTOR_ALREADY_CONFIGURED = 'Connector already configured';

function handleError(operation: 'init-sdk' | 'create-purchase-connector') {
  return (_details: unknown) => {
    Sentry.captureException(new Error(`AppsFlyer ${operation} failed`), {
      tags: {
        'error.subsystem': 'appsflyer',
        'error.operation': operation,
      },
      extra: { platform: Platform.OS },
      fingerprint: ['appsflyer', operation],
    });
  };
}

const ErrorRecordSchema = z.looseObject({
  code: z.string().optional(),
  message: z.string().optional(),
});

const rejectionStringSchema = z.string();

function rejectionText(error: unknown): string {
  const asString = rejectionStringSchema.safeParse(error);
  if (asString.success) {
    return asString.data;
  }
  if (error instanceof Error) {
    return error.message;
  }
  const record = ErrorRecordSchema.safeParse(error);
  if (record.success) {
    const parts = [record.data.code, record.data.message].filter(
      (part): part is string => part !== undefined
    );
    if (parts.length > 0) {
      return parts.join(' ');
    }
  }
  return '';
}

function isConnectorAlreadyConfigured(error: unknown): boolean {
  if (error == null) {
    return false;
  }
  const record = ErrorRecordSchema.safeParse(error);
  if (record.success) {
    if (record.data.code === CONNECTOR_ALREADY_CONFIGURED) {
      return true;
    }
    if (record.data.message === CONNECTOR_ALREADY_CONFIGURED) {
      return true;
    }
  }
  return rejectionText(error).includes(CONNECTOR_ALREADY_CONFIGURED);
}

/**
 * Reports whether the native purchase connector is configured.
 *
 * Native PCAppsFlyer keeps a process-lifetime static connector. A JS reload
 * resets module state while native state survives, so create() then rejects
 * with "Connector already configured" — which still means configured. Any
 * other failure goes to Sentry and leaves the connector unusable.
 */
async function createPurchaseConnector(): Promise<boolean> {
  try {
    await AppsFlyerPurchaseConnector.create({
      logSubscriptions: true,
      logInApps: false,
      sandbox: __DEV__,
      storeKitVersion: StoreKitVersion.SK2,
    });
    return true;
  } catch (error: unknown) {
    if (isConnectorAlreadyConfigured(error)) {
      return true;
    }
    handleError('create-purchase-connector')(error);
    return false;
  }
}

/**
 * Runs a connector call only once the connector is known to be configured.
 * The library discards the promise that start/stopObservingTransactions
 * return, so a native "Connector not configured" rejection escapes as an
 * unhandled rejection and lands in Sentry. `connectorReady` stays null on
 * Android and before the first create(), so both calls are skipped there.
 */
async function whenConnectorReady(action: () => void): Promise<void> {
  if (connectorReady === null || !(await connectorReady)) {
    return;
  }
  try {
    action();
  } catch {
    // Native module missing or threw synchronously.
  }
}

/**
 * Serializes the SDK state calls: consent, stop/resume and start. Android runs
 * them on a concurrent thread pool, so without this a consent revoke's stop
 * could land before an earlier resume or start and leave the SDK running.
 */
let stateCalls: Promise<undefined> | null = null;

async function queueStateCall<T>(call: () => Promise<T>): Promise<T> {
  const previous = stateCalls;
  const { promise: done, resolve: release } = Promise.withResolvers<undefined>();
  stateCalls = done;
  try {
    await previous;
    return await call();
  } finally {
    release(undefined);
  }
}

// AppsFlyer 6.x held the first launch natively (timeToWaitForATTUserAuthorization: 10);
// 7.x removed that option and leaves the wait to the app.
const TRACKING_DECISION_TIMEOUT_MS = 10_000;
const TRACKING_DECISION_POLL_MS = 250;

async function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<undefined>();
  setTimeout(resolve, ms);
  await promise;
}

/**
 * Holds the first launch for up to 10 s while the iOS tracking prompt is
 * unanswered, so an install whose user allows tracking carries the IDFA. The
 * prompt runs alongside SDK startup (`useTrackingPermissionPrompt`).
 */
async function waitForTrackingDecision(): Promise<void> {
  if (Platform.OS !== 'ios') {
    return;
  }
  const deadline = Date.now() + TRACKING_DECISION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      // eslint-disable-next-line no-await-in-loop -- each status read must settle before the next poll
      const { status } = await getTrackingPermissionsAsync();
      if (status !== PermissionStatus.UNDETERMINED) {
        return;
      }
    } catch {
      // Unreadable status: start now rather than hold attribution back.
      return;
    }
    // eslint-disable-next-line no-await-in-loop -- poll cadence
    await delay(TRACKING_DECISION_POLL_MS);
  }
}

// Bound AppsFlyer logEvent so a test spy can wrap the real transport without
// replacing the SDK import. `trackEvent` and `drainPendingEvents` route
// through `logEventImpl`, which defaults to the bound SDK call.
type AppsFlyerLogEvent = (eventName: string, eventValues: Record<string, string>) => Promise<void>;
const defaultLogEvent: AppsFlyerLogEvent = async (eventName, eventValues) => {
  await appsFlyer.logEvent({ eventName, eventValues });
};
let logEventImpl: AppsFlyerLogEvent = defaultLogEvent;

/** Test-only wrap hook (slice P3-AH-16a). Replaces the logEvent implementation
 *  with wrap(boundAppsFlyerLogEvent). */
export function wrapAppsFlyerLogEventForTests(
  wrap: (logEvent: AppsFlyerLogEvent) => AppsFlyerLogEvent
): void {
  logEventImpl = wrap(defaultLogEvent);
}

/**
 * logEvent resolves once the SDK has queued the event; the SDK owns delivery
 * and retries it itself. A failure is a transport failure (offline,
 * DNS-blocked, ad-blocker, corporate proxy) that no developer can act on, so
 * it is not reported. Actionable AppsFlyer failures — a bad dev key or app
 * id, or a broken purchase connector — still reach Sentry through startup's
 * and the connector's error handling.
 */
async function sendEvent(name: string, values: Record<string, string>): Promise<void> {
  try {
    await logEventImpl(name, values);
  } catch {
    // Not reported; see above.
  }
}

function drainPendingEvents() {
  for (const event of pendingEvents) {
    if (event.generation === currentGeneration()) {
      void sendEvent(event.name, event.values);
    }
  }
  pendingEvents.length = 0;
}

/**
 * Starts the SDK session once native reports the session ready. The 7.x SDK
 * never starts on its own. Marks the SDK initialized only after start()
 * succeeds, then observes purchases and drains the pending events.
 */
async function startSession(isCurrent: () => boolean): Promise<void> {
  await waitForTrackingDecision();
  if (!isCurrent()) {
    return;
  }
  try {
    await queueStateCall(async () => {
      await appsFlyer.start();
    });
  } catch (error: unknown) {
    if (isCurrent()) {
      handleError('init-sdk')(error);
    }
    return;
  }
  if (!isCurrent()) {
    return;
  }
  initialized = true;
  void whenConnectorReady(() => {
    // Re-check: a reset can land while the create() promise settles.
    if (!isCurrent()) {
      return;
    }
    AppsFlyerPurchaseConnector.startObservingTransactions();
  });
  drainPendingEvents();
}

async function startAppsFlyer(isCurrent: () => boolean): Promise<void> {
  // Send the optional-consent signal and resume a SDK that a prior reset
  // stopped, both before init, so attribution data is either collected with
  // consent or not collected at all. 7.x requires isUserSubjectToGDPR and no
  // longer accepts "not determined". We do not know the user's GDPR status at
  // this layer, and a false negative is a legal risk, so GDPR is treated as
  // applying, with the consent the user gave.
  await Promise.allSettled([
    queueStateCall(async () => {
      await appsFlyer.setConsentData({
        isUserSubjectToGDPR: true,
        hasConsentForDataUsage: allowsOptional(),
        hasConsentForAdsPersonalization: allowsOptional(),
        hasConsentForAdStorage: allowsOptional(),
      });
    }),
    queueStateCall(async () => {
      await appsFlyer.stop({ shouldStop: false });
    }),
  ]);
  if (!isCurrent()) {
    return;
  }

  void initSdk();
  let startRequested = false;
  const startWhenReady = () => {
    if (startRequested || !isCurrent()) {
      return;
    }
    startRequested = true;
    void startSession(isCurrent);
  };
  // Registered right after init(), not after it resolves, so the session-ready
  // event cannot slip past the listener.
  try {
    await appsFlyer.registerSessionReadyListener(startWhenReady);
    // A re-init after a reset may find the session already ready, with no
    // new session-ready event to come.
    if (await appsFlyer.isSessionReady()) {
      startWhenReady();
    }
  } catch (error: unknown) {
    handleError('init-sdk')(error);
  }
}

async function initSdk(): Promise<void> {
  try {
    await appsFlyer.init({ devKey: APPSFLYER_DEV_KEY, appId: APPSFLYER_APP_ID });
  } catch (error: unknown) {
    handleError('init-sdk')(error);
  }
}

async function stopSdk(): Promise<void> {
  try {
    await queueStateCall(async () => {
      await appsFlyer.stop({ shouldStop: true });
    });
  } catch {
    // Native stop may fail — JS invalidation has already run.
  }
}

export function initAppsFlyer(): void {
  if (!allowsOptional()) {
    return;
  }
  if (initialized) {
    return;
  }

  // Purchase Connector auto-observes StoreKit transactions and validates
  // purchase revenue server-side, so revenue is attributed without touching the
  // purchase flow. iOS-only: Kilo Pass IAP ships on iOS only (subscriptions,
  // StoreKit 2 via expo-iap). Create it before the SDK starts and start
  // observing once both the SDK has started and the connector is configured.
  if (Platform.OS === 'ios') {
    connectorReady ??= createPurchaseConnector();
  }

  const initGeneration = currentGeneration();
  const initToken = callbackToken;
  void startAppsFlyer(() => currentGeneration() === initGeneration && callbackToken === initToken);
}

export function trackEvent(name: string, values?: Record<string, string>): void {
  if (!allowsOptional()) {
    return;
  }
  const eventValues = values ?? {};

  // Mirror attribution events into PostHog so the onboarding funnel is
  // visible in product analytics too. Both SDKs sit behind the same consent
  // gate; `captureEvent` no-ops until PostHog is initialized and drops any
  // payload key that names a prohibited data class. These names are dynamic,
  // so they resolve to `captureEvent`'s uncataloged overload.
  captureEvent(name, eventValues);

  if (!initialized) {
    pendingEvents.push({ name, values: eventValues, generation: currentGeneration() });
    return;
  }

  void sendEvent(name, eventValues);
}

/**
 * Tear down the native SDK and clear JS state. Queues `stop({shouldStop: true})`
 * behind any in-flight resume or start, then, on iOS, calls
 * `stopObservingTransactions()`. Also clears the pending-event buffer so stale
 * events from a prior account do not transmit on a later init.
 *
 * Does NOT clear `connectorReady`: native `PCAppsFlyer` keeps a
 * process-lifetime static connector, so re-entering `create()` rejects with
 * "Connector already configured".
 */
export function resetAppsFlyerState(): void {
  // Invalidate JS state BEFORE native teardown calls, so a late session-ready
  // or start() after reset cannot re-arm the SDK or drain events.
  callbackToken += 1;
  initialized = false;
  pendingEvents.length = 0;

  void stopSdk();

  void whenConnectorReady(() => {
    AppsFlyerPurchaseConnector.stopObservingTransactions();
  });
}
