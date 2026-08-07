import * as Sentry from '@sentry/react-native';
import { Platform } from 'react-native';
import appsFlyer, {
  AppsFlyerConsent,
  AppsFlyerPurchaseConnector,
  StoreKitVersion,
} from 'react-native-appsflyer';

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
 * Invalidation token for in-flight initSdk callbacks. Incremented by
 * `resetAppsFlyerState()` so a late success after stop/optional revoke
 * cannot re-arm the SDK even when generation is unchanged.
 */
let callbackToken = 0;
type PendingEvent = {
  name: string;
  values: Record<string, string>;
  generation: number;
};
const pendingEvents: PendingEvent[] = [];

const CONNECTOR_ALREADY_CONFIGURED = 'Connector already configured';

function handleError(message: string) {
  return (details: unknown) => {
    Sentry.captureException(new Error(`${message}: ${String(details)}`));
  };
}

function rejectionText(error: unknown): string {
  if (typeof error === 'string') {
    return error;
  }
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'object' && error !== null) {
    const record = error as { code?: unknown; message?: unknown };
    const parts: string[] = [];
    if (typeof record.code === 'string') {
      parts.push(record.code);
    }
    if (typeof record.message === 'string') {
      parts.push(record.message);
    }
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
  if (typeof error === 'object') {
    const record = error as { code?: unknown; message?: unknown };
    if (record.code === CONNECTOR_ALREADY_CONFIGURED) {
      return true;
    }
    if (record.message === CONNECTOR_ALREADY_CONFIGURED) {
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
    handleError('AppsFlyer purchase connector failed')(error);
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

// eslint-disable-next-line @typescript-eslint/no-empty-function -- AppsFlyer SDK callbacks are required arguments
function noop() {}

function drainPendingEvents() {
  for (const event of pendingEvents) {
    if (event.generation === currentGeneration()) {
      // Error callback is `noop` for the same reason as in trackEvent below.
      appsFlyer.logEvent(event.name, event.values, noop, noop);
    }
  }
  pendingEvents.length = 0;
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
  // StoreKit 2 via expo-iap). Create it before initSdk and start observing once
  // both the SDK has started and the connector is configured.
  if (Platform.OS === 'ios') {
    connectorReady ??= createPurchaseConnector();
  }

  // Send the optional-consent signal before the SDK starts so attribution
  // data is either collected with consent or not collected at all.
  // isUserSubjectToGDPR is left undefined: we do not know the user's GDPR
  // status at this layer, and a false negative is a legal risk.  The SDK
  // treats undefined as "not determined."
  appsFlyer.setConsentData(
    new AppsFlyerConsent(undefined, allowsOptional(), allowsOptional(), allowsOptional())
  );

  // Resume the SDK if it was stopped by a prior reset. Native stop may throw
  // synchronously — catch it so initSdk still proceeds.
  try {
    if (typeof (appsFlyer as Record<string, unknown>).stop === 'function') {
      appsFlyer.stop(false);
    }
  } catch {
    // Native stop threw; JS invalidation (if any) already ran in resetAppsFlyerState.
  }

  const initGeneration = currentGeneration();
  const initToken = callbackToken;
  appsFlyer.initSdk(
    {
      devKey: APPSFLYER_DEV_KEY,
      isDebug: false,
      appId: APPSFLYER_APP_ID,
      onInstallConversionDataListener: true,
      timeToWaitForATTUserAuthorization: 10,
    },
    () => {
      if (currentGeneration() !== initGeneration || callbackToken !== initToken) {
        return;
      }
      initialized = true;
      void whenConnectorReady(() => {
        // Re-check: a reset can land while the create() promise settles.
        if (currentGeneration() !== initGeneration || callbackToken !== initToken) {
          return;
        }
        AppsFlyerPurchaseConnector.startObservingTransactions();
      });
      drainPendingEvents();
    },
    handleError('AppsFlyer init failed')
  );
}

export function trackEvent(name: string, values?: Record<string, string>): void {
  if (!allowsOptional()) {
    return;
  }
  const eventValues = values ?? {};

  // Mirror attribution events into PostHog so the onboarding funnel is
  // visible in product analytics too. Both SDKs sit behind the same consent
  // gate; captureEvent no-ops until PostHog is initialized.
  captureEvent(name, eventValues);

  if (!initialized) {
    pendingEvents.push({ name, values: eventValues, generation: currentGeneration() });
    return;
  }

  // A logEvent delivery failure is a transport failure (offline, DNS-blocked,
  // ad-blocker, corporate proxy) that the SDK retries itself and no developer
  // can act on, so it is not reported. Actionable AppsFlyer failures — a bad
  // dev key or app id, or a broken purchase connector — still reach Sentry
  // through initSdk's and the connector's error callbacks.
  appsFlyer.logEvent(name, eventValues, noop, noop);
}

/**
 * Tear down the native SDK and clear JS state. Calls `stop(true)` to stop
 * native transmission, then, on iOS, `stopObservingTransactions()`. Also
 * clears the pending-event buffer so stale events from a prior account do
 * not transmit on a later init.
 *
 * Does NOT clear `connectorReady`: native `PCAppsFlyer` keeps a
 * process-lifetime static connector, so re-entering `create()` rejects with
 * "Connector already configured".
 */
export function resetAppsFlyerState(): void {
  // Invalidate JS state BEFORE native teardown calls. If a native call throws,
  // the JS token, the initialized flag, and pendingEvents are already cleared —
  // a late initSdk success after reset cannot re-arm the SDK or drain events.
  callbackToken += 1;
  initialized = false;
  pendingEvents.length = 0;

  try {
    if (typeof (appsFlyer as Record<string, unknown>).stop === 'function') {
      appsFlyer.stop(true);
    }
  } catch {
    // Native stop may throw — JS invalidation has already run.
  }

  void whenConnectorReady(() => {
    AppsFlyerPurchaseConnector.stopObservingTransactions();
  });
}
