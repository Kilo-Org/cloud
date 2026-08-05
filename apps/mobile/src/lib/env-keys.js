/** Config key → environment variable name. Single source of truth for both
 *  build-time validation (app.config.ts) and runtime access (config.ts). */
export const ENV_KEYS = {
  apiBaseUrl: 'API_BASE_URL',
  webBaseUrl: 'WEB_BASE_URL',
  cloudAgentWsUrl: 'CLOUD_AGENT_WS_URL',
  sessionIngestWsUrl: 'SESSION_INGEST_WS_URL',
  appsFlyerDevKey: 'APPSFLYER_DEV_KEY',
  appsFlyerAppId: 'APPSFLYER_APP_ID',
  kiloChatUrl: 'KILO_CHAT_URL',
  eventServiceUrl: 'EVENT_SERVICE_URL',
  notificationsUrl: 'NOTIFICATIONS_URL',
  posthogApiKey: 'POSTHOG_API_KEY',
};

/** Optional config keys — absent values are tolerated (dependent features hide themselves). */
export const OPTIONAL_ENV_KEYS = {
  googleWebClientId: 'GOOGLE_WEB_CLIENT_ID',
  googleIosClientId: 'GOOGLE_IOS_CLIENT_ID',
  // Google Cloud project number for Play Integrity. Absent → Android skips
  // admission and the server's counted legacy path decides.
  playIntegrityProjectNumber: 'GOOGLE_PLAY_INTEGRITY_PROJECT_NUMBER',
  e2eLatencySessionMs: 'E2E_LATENCY_SESSION_MS',
  e2eLatencyMessagesMs: 'E2E_LATENCY_MESSAGES_MS',
  e2eLatencyWsMs: 'E2E_LATENCY_WS_MS',
  sentryEnvironment: 'EXPO_PUBLIC_SENTRY_ENVIRONMENT',
};
