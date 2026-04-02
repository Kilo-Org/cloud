import * as Sentry from '@sentry/react-native';
import expoConstants from 'expo-constants';
import appsFlyer from 'react-native-appsflyer';

const devKey = expoConstants.expoConfig?.extra?.appsFlyerDevKey as string | undefined;
const appId = expoConstants.expoConfig?.extra?.appsFlyerAppId as string | undefined;

let initialized = false;

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
    error => {
      Sentry.captureException(new Error(`AppsFlyer init failed: ${error}`));
    }
  );
}

export function trackEvent(name: string, values?: Record<string, string>): void {
  if (!initialized) {
    return;
  }

  appsFlyer.logEvent(
    name,
    values ?? {},
    () => {},
    error => {
      Sentry.captureException(new Error(`AppsFlyer event "${name}" failed: ${error}`));
    }
  );
}
