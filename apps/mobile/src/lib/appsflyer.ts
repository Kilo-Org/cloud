import * as Sentry from '@sentry/react-native';
import { Platform } from 'react-native';
import appsFlyer, { AppsFlyerPurchaseConnector, StoreKitVersion } from 'react-native-appsflyer';

import { captureEvent } from '@/lib/analytics/posthog';
import { APPSFLYER_APP_ID, APPSFLYER_DEV_KEY } from '@/lib/config';

let initialized = false;
const pendingEvents: { name: string; values: Record<string, string> }[] = [];

function handleError(message: string) {
  return (details: unknown) => {
    Sentry.captureException(new Error(`${message}: ${String(details)}`));
  };
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
  if (Platform.OS === 'ios') {
    AppsFlyerPurchaseConnector.create({
      logSubscriptions: true,
      logInApps: false,
      sandbox: __DEV__,
      storeKitVersion: StoreKitVersion.SK2,
    });
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
