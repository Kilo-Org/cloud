export const SENTRY_DSN =
  'https://618cf025f1c6bdea8043fcd80668fe6b@o4509356317474816.ingest.us.sentry.io/4511110711279616';

export const SENTRY_NATIVE_OPTIONS = {
  dsn: SENTRY_DSN,
  sendDefaultPii: false,
  enableTombstone: true,
  enableMetricKit: true,
  enableAppHangTracking: false,
  tracesSampleRate: 0,
};
