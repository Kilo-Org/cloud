import expoConstants from 'expo-constants';
import { type ENV_KEYS, type OPTIONAL_ENV_KEYS } from './env-keys';
import {
  assertProductionHost,
  assertUrlScheme,
  PRODUCTION_HOSTS,
  URL_SCHEMES,
} from '@/lib/url-contract';

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
export const TERMS_URL = `${WEB_BASE_URL}/terms-app`;
export const PRIVACY_URL = `${WEB_BASE_URL}/privacy-app`;
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
export const PLAY_INTEGRITY_PROJECT_NUMBER: string | undefined = optional(
  'playIntegrityProjectNumber'
);
export const SENTRY_ENVIRONMENT: string | undefined = optional('sentryEnvironment');

// URL contract at module evaluation. The production host check keys off the
// baked `extra.isProductionBuild` flag, not the Sentry environment, so a
// preview release build never crashes on preview hosts. The `required`
// presence check above is the old presence-only check; remove it when every
// build passes through the config boundary in app.config.ts, which already
// throws on missing values.
const runProductionHostCheck = !__DEV__ && extra?.isProductionBuild === true;
for (const [key, schemes] of Object.entries(URL_SCHEMES)) {
  const value = required(key as keyof typeof ENV_KEYS);
  assertUrlScheme(key, value, schemes, { allowInsecure: __DEV__ });
  if (runProductionHostCheck) {
    assertProductionHost(key, value, PRODUCTION_HOSTS);
  }
}

function optionalLatencyMs(key: keyof typeof OPTIONAL_ENV_KEYS): number {
  const parsed = Number.parseInt(optional(key) ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/** E2E-only artificial backend latency (see lib/trpc.ts). 0 = disabled. */
export const E2E_LATENCY_SESSION_MS: number = optionalLatencyMs('e2eLatencySessionMs');
export const E2E_LATENCY_MESSAGES_MS: number = optionalLatencyMs('e2eLatencyMessagesMs');
export const E2E_LATENCY_WS_MS: number = optionalLatencyMs('e2eLatencyWsMs');
