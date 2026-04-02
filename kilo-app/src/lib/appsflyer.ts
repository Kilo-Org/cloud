import * as Sentry from '@sentry/react-native';
import expoConstants from 'expo-constants';
import appsFlyer from 'react-native-appsflyer';

const devKey = expoConstants.expoConfig?.extra?.appsFlyerDevKey as string | undefined;
const appId = expoConstants.expoConfig?.extra?.appsFlyerAppId as string | undefined;

let initialized = false;

function handleError(message: string) {
  return (details: unknown) => {
    Sentry.captureException(new Error(`${message}: ${String(details)}`));
  };
}

// eslint-disable-next-line @typescript-eslint/no-empty-function -- AppsFlyer SDK requires a success callback
function noop() {}

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
    },
    handleError('AppsFlyer init failed')
  );
}

export function trackEvent(name: string, values?: Record<string, string>): void {
  if (!initialized) {
    return;
  }

  appsFlyer.logEvent(name, values ?? {}, noop, handleError(`AppsFlyer event "${name}" failed`));
}
