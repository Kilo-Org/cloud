/** Public Sentry DSN and native init options, shared by JS init
 *  (_layout.tsx) and the config plugin (app.config.ts).
 *  Plain .js because the Expo config loader cannot consume workspace TS
 *  (same reason env-keys.js exists). */
export const SENTRY_DSN =
  'https://618cf025f1c6bdea8043fcd80668fe6b@o4506633492365312.ingest.us.sentry.io/4511110711279616';

export const SENTRY_NATIVE_OPTIONS = {
  dsn: SENTRY_DSN,
  sendDefaultPii: false,
  enableTombstone: true,
  enableMetricKit: true,
  enableAppHangTracking: false,
  tracesSampleRate: 0,
  // This file reaches the native SDK through the Expo plugin, and native init
  // runs before any JS. Leaving the NDK in-process handler off here means a
  // crash in that window can never be replaced by the handler's own
  // std::bad_alloc abort while it parses /proc/self/maps. JS init enables the
  // handler again below Android 12, where no tombstone exists and it is the
  // only native crash source (sentry-init.ts).
  enableNdk: false,
};
