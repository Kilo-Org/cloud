import * as Sentry from '@sentry/react-native';
import expoConstants from 'expo-constants';
import appsFlyer from 'react-native-appsflyer';

const devKey = expoConstants.expoConfig?.extra?.appsFlyerDevKey as string | undefined;
const appId = expoConstants.expoConfig?.extra?.appsFlyerAppId as string | undefined;

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
  if (initialized || !devKey) {
    return;
  }

  appsFlyer.initSdk(
    {
      devKey,
      isDebug: false,
      appId: appId ?? '',
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
