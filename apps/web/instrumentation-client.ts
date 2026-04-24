import { captureRouterTransitionStart, init } from '@sentry/nextjs';

if (process.env.NODE_ENV !== 'development') {
  init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    sendDefaultPii: false,
    normalizeDepth: 5,
    // Tracing is fully disabled.
    tracesSampleRate: 0,
    // Note: if you want to override the automatic release value, do not set a
    // `release` value here - use the environment variable `SENTRY_RELEASE`, so
    // that it will also get attached to your source maps
  });
}

// This export will instrument router navigations, and is only relevant if you enable tracing.
// `captureRouterTransitionStart` is available from SDK version 9.12.0 onwards
export const onRouterTransitionStart = captureRouterTransitionStart;
