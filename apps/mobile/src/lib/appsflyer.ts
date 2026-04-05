import * as Sentry from '@sentry/react-native';
import appsFlyer from 'react-native-appsflyer';

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
      drainPendingEvents();
    },
    handleError('AppsFlyer init failed')
  );
}

export function trackEvent(name: string, values?: Record<string, string>): void {
  const eventValues = values ?? {};

  if (!initialized) {
    pendingEvents.push({ name, values: eventValues });
    return;
  }

  appsFlyer.logEvent(name, eventValues, noop, handleError(`AppsFlyer event "${name}" failed`));
}
