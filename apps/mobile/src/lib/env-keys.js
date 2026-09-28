/** Config key → environment variable name. Single source of truth for both
 *  build-time validation (app.config.ts) and runtime access (config.ts).
 *  Required keys only: app.config.ts's missing-value check enumerates this map
 *  and the `extra` spread bakes every entry, so an optional key must not be one
 *  of them (see the URL-contract entry below). */
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

// The build-time URL contract loop in app.config.ts resolves every URL_SCHEMES
// key through ENV_KEYS (`process.env[ENV_KEYS[key]]`), so an optional URL key
// whose name lives only in OPTIONAL_ENV_KEYS silently skips its scheme and
// production-host check — a bad LATENCY_INGEST_URL override then reached the
// shipped build and threw at launch in config.ts. Resolve it here instead:
// non-enumerable, so the lookup finds the name while `Object.values(ENV_KEYS)`
// (the required-presence check) and the `extra` spread stay required-only.
// Add an entry for every optional key URL_SCHEMES gains.
Object.defineProperty(ENV_KEYS, 'latencyIngestUrl', {
  value: OPTIONAL_ENV_KEYS.latencyIngestUrl,
  enumerable: false,
});
