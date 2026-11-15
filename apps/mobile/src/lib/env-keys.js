/** Config key → environment variable name. Single source of truth for both
 *  build-time validation (app.config.ts) and runtime access (config.ts).
 *  Required keys only: app.config.ts's missing-value check enumerates this map
 *  and the `extra` spread bakes every entry, so an optional key must not be one
 *  of them. A URL key may be either kind, so the build-time URL contract reads
 *  both maps (see app.config.ts). */
export const ENV_KEYS = {
  apiBaseUrl: 'API_BASE_URL',
  webBaseUrl: 'WEB_BASE_URL',
  cloudAgentWsUrl: 'CLOUD_AGENT_WS_URL',
  sessionIngestWsUrl: 'SESSION_INGEST_WS_URL',
  appsFlyerDevKey: 'APPSFLYER_DEV_KEY',
  appsFlyerAppId: 'APPSFLYER_APP_ID',
  eventServiceUrl: 'EVENT_SERVICE_URL',
  notificationsUrl: 'NOTIFICATIONS_URL',
  posthogApiKey: 'POSTHOG_API_KEY',
};

/** Optional config keys — absent values are tolerated (dependent features hide themselves). */
export const OPTIONAL_ENV_KEYS = {
  // The Kilo MCP server the chat reaches with the signed-in session's own
  // token. An override: a production build resolves the public server in
  // lib/config.ts, and a build that is neither production nor given a value
  // hides the whole feature, as with every optional key.
  kiloMcpUrl: 'KILO_MCP_URL',
  googleWebClientId: 'GOOGLE_WEB_CLIENT_ID',
  googleIosClientId: 'GOOGLE_IOS_CLIENT_ID',
  // Google Cloud project number for Play Integrity. Absent in a non-production
  // build → Android sends the dev sentinel; absent in production → every new
  // native signup is refused, because admission is mandatory.
  playIntegrityProjectNumber: 'GOOGLE_PLAY_INTEGRITY_PROJECT_NUMBER',
  // Non-production only: sends the fixed admission sentinel from a device that
  // cannot attest. The server ignores it when it runs in production.
  nativeAdmissionDevSentinel: 'NATIVE_ADMISSION_DEV_SENTINEL',
  e2eLatencySessionMs: 'E2E_LATENCY_SESSION_MS',
  e2eLatencyMessagesMs: 'E2E_LATENCY_MESSAGES_MS',
  e2eLatencyWsMs: 'E2E_LATENCY_WS_MS',
  // E2E-only: milliseconds after bundle load during which every read
  // through lib/auth/secure-store-read rejects, so the session-restore
  // failure states are provable on a live build.
  e2eSecureStoreFaultMs: 'E2E_SECURE_STORE_FAULT_MS',
  sentryEnvironment: 'EXPO_PUBLIC_SENTRY_ENVIRONMENT',
  // Client-observed request-latency ingest endpoint. Optional: config.ts falls
  // back to the committed LATENCY_INGEST_URL_DEFAULT (url-contract.js), so a
  // build with no env value still samples.
  latencyIngestUrl: 'LATENCY_INGEST_URL',
};
