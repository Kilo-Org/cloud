import expoConstants from 'expo-constants';
import { type ENV_KEYS, type OPTIONAL_ENV_KEYS } from './env-keys';

const extra = expoConstants.expoConfig?.extra;

function required(key: keyof typeof ENV_KEYS): string {
  const value = extra?.[key] as string | undefined;
  if (!value) {
    throw new Error(`Missing required config: ${key}`);
  }
  return value;
}

function optional(key: keyof typeof OPTIONAL_ENV_KEYS): string | undefined {
  return extra?.[key] as string | undefined;
}

export const API_BASE_URL: string = required('apiBaseUrl');
export const WEB_BASE_URL: string = required('webBaseUrl');
export const APPSFLYER_DEV_KEY: string = required('appsFlyerDevKey');
export const APPSFLYER_APP_ID: string = required('appsFlyerAppId');

export const CLOUD_AGENT_WS_URL: string = required('cloudAgentWsUrl');
export const SESSION_INGEST_WS_URL: string = required('sessionIngestWsUrl');

export const KILO_CHAT_URL: string = required('kiloChatUrl');
export const EVENT_SERVICE_URL: string = required('eventServiceUrl');
export const NOTIFICATIONS_URL: string = required('notificationsUrl');
export const POSTHOG_API_KEY: string = required('posthogApiKey');

export const GOOGLE_WEB_CLIENT_ID: string | undefined = optional('googleWebClientId');
export const GOOGLE_IOS_CLIENT_ID: string | undefined = optional('googleIosClientId');
