import expoConstants from 'expo-constants';
import { type ENV_KEYS, type OPTIONAL_ENV_KEYS } from './env-keys';
import {
  assertProductionHost,
  assertUrlScheme,
  LATENCY_INGEST_URL_DEFAULT,
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

// The Kilo MCP server a production build reaches with the signed-in session's
// own token (lib/chat/kilo-mcp.ts). It is resolved here, at the runtime config
// boundary every screen already reads, and not in app.config.ts (the native
// config that registers plugins): it is a plain URL value, identical on iOS and
// Android, and both platforms read it through this module. A build given
// KILO_MCP_URL (the device build points at the local stack) overrides it; one
// that is neither production nor given a value leaves the key undefined, which
// hides the whole feature.
const KILO_MCP_URL_PRODUCTION = 'https://mcp.kiloapps.io';

export const KILO_MCP_URL: string | undefined =
  optional('kiloMcpUrl') ??
  (extra?.isProductionBuild === true ? KILO_MCP_URL_PRODUCTION : undefined);
export const GOOGLE_WEB_CLIENT_ID: string | undefined = optional('googleWebClientId');
export const GOOGLE_IOS_CLIENT_ID: string | undefined = optional('googleIosClientId');
export const PLAY_INTEGRITY_PROJECT_NUMBER: string | undefined = optional(
  'playIntegrityProjectNumber'
);
export const SENTRY_ENVIRONMENT: string | undefined = optional('sentryEnvironment');

/** Client-observed latency ingest endpoint. The optional `LATENCY_INGEST_URL`
 *  key overrides the committed production default, so every shipped build
 *  carries an endpoint without a committed .env value. */
export const LATENCY_INGEST_URL: string | undefined =
  optional('latencyIngestUrl') ?? LATENCY_INGEST_URL_DEFAULT;

// URL contract at module evaluation. The production host check keys off the
// baked `extra.isProductionBuild` flag, not the Sentry environment, so a
// preview release build never crashes on preview hosts. The optional URL key
// (the latency ingest endpoint) is skipped when absent — its committed default
// is asserted by url-contract.test.ts — so a checkout with no env value still
// starts; every required URL key is presence-checked by its `required(...)`
// export above.
const runProductionHostCheck = !__DEV__ && extra?.isProductionBuild === true;
for (const [key, schemes] of Object.entries(URL_SCHEMES)) {
  const value = extra?.[key] as string | undefined;
  if (value) {
    assertUrlScheme(key, value, schemes, { allowInsecure: __DEV__ });
    if (runProductionHostCheck) {
      assertProductionHost(key, value, PRODUCTION_HOSTS);
    }
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

/** E2E-only secure-store fault window (see lib/auth/secure-store-read.ts):
 *  while it is open, every read through the retry helper rejects. 0 = disabled. */
export const E2E_SECURE_STORE_FAULT_MS: number = optionalLatencyMs('e2eSecureStoreFaultMs');
