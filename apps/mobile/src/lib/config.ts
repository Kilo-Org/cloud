import expoConstants from 'expo-constants';

const extra = expoConstants.expoConfig?.extra;

function required(key: string): string {
  const value = extra?.[key] as string | undefined;
  if (!value) {
    throw new Error(`Missing required config: ${key}`);
  }
  return value;
}

export const API_BASE_URL: string = required('apiBaseUrl');
export const WEB_BASE_URL: string = required('webBaseUrl');
export const APPSFLYER_DEV_KEY: string = required('appsFlyerDevKey');
export const APPSFLYER_APP_ID: string = required('appsFlyerAppId');
