import * as Sentry from '@sentry/react-native';
import { Platform } from 'react-native';
import appsFlyer, { AppsFlyerPurchaseConnector, StoreKitVersion } from 'react-native-appsflyer';

import { captureEvent } from '@/lib/analytics/posthog';
import { APPSFLYER_APP_ID, APPSFLYER_DEV_KEY } from '@/lib/config';

let initialized = false;
/** Blocks re-entry into create() within one JS bundle (before initSdk succeeds). */
let purchaseConnectorCreateStarted = false;
const pendingEvents: { name: string; values: Record<string, string> }[] = [];

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
 * Settles create() without floating promises. `Promise.resolve` normalizes a
 * non-promise return (bare mocks / unpatched install) so await never throws
 * TypeError. Known-benign "already configured" is swallowed; anything else
 * goes to Sentry via handleError.
 */
async function settlePurchaseConnectorCreate(
  createResult: void | PromiseLike<void>
): Promise<void> {
  try {
    await Promise.resolve(createResult);
  } catch (error: unknown) {
    if (isConnectorAlreadyConfigured(error)) {
      return;
    }
    handleError('AppsFlyer purchase connector failed')(error);
  }
}

// eslint-disable-next-line @typescript-eslint/no-empty-function -- AppsFlyer SDK requires a success callback
function noop() {}

function drainPendingEvents() {
  for (const event of pendingEvents) {
    appsFlyer.logEvent(
      event.name,
      event.values,
      noop,
      handleError(`AppsFlyer event "${event.name}" failed`)
    );
  }
  pendingEvents.length = 0;
}

export function initAppsFlyer(): void {
  if (initialized) {
    return;
  }

  // Purchase Connector auto-observes StoreKit transactions and validates
  // purchase revenue server-side, so revenue is attributed without touching the
  // purchase flow. iOS-only: Kilo Pass IAP ships on iOS only (subscriptions,
  // StoreKit 2 via expo-iap). Create it before initSdk and start observing once
  // the SDK has started (in the success callback below).
  //
  // Native PCAppsFlyer keeps a process-lifetime static connector. JS reloads
  // reset module state while native state remains, so create() can reject with
  // "Connector already configured". Guard sync re-entry within one bundle and
  // swallow only that known-benign rejection (any other failure goes to Sentry).
  if (Platform.OS === 'ios' && !purchaseConnectorCreateStarted) {
    purchaseConnectorCreateStarted = true;
    void settlePurchaseConnectorCreate(
      AppsFlyerPurchaseConnector.create({
        logSubscriptions: true,
        logInApps: false,
        sandbox: __DEV__,
        storeKitVersion: StoreKitVersion.SK2,
      })
    );
  }

  appsFlyer.initSdk(
    {
      devKey: APPSFLYER_DEV_KEY,
      isDebug: false,
      appId: APPSFLYER_APP_ID,
      onInstallConversionDataListener: true,
      timeToWaitForATTUserAuthorization: 10,
    },
    () => {
      initialized = true;
      if (Platform.OS === 'ios') {
        AppsFlyerPurchaseConnector.startObservingTransactions();
      }
      drainPendingEvents();
    },
    handleError('AppsFlyer init failed')
  );
}

export function trackEvent(name: string, values?: Record<string, string>): void {
  const eventValues = values ?? {};

  // Mirror attribution events into PostHog so the onboarding funnel is
  // visible in product analytics too. Both SDKs sit behind the same consent
  // gate; captureEvent no-ops until PostHog is initialized.
  captureEvent(name, eventValues);

  if (!initialized) {
    pendingEvents.push({ name, values: eventValues });
    return;
  }

  appsFlyer.logEvent(name, eventValues, noop, handleError(`AppsFlyer event "${name}" failed`));
}
