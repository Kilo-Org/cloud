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
};
