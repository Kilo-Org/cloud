// This file configures the initialization of Sentry on the server.
// The config you add here will be used whenever the server handles a request.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/
// But note tricky corner cases using vercel otel with sentry:
// https://docs.sentry.io/platforms/javascript/guides/nextjs/opentelemetry/custom-setup/

import { consoleLoggingIntegration, httpIntegration, init } from '@sentry/nextjs';

type DrizzleQueryError = Error & {
  query: string;
  params: unknown[];
  cause?: { code?: string; message?: string };
};

function isDrizzleQueryError(error: unknown): error is DrizzleQueryError {
  return (
    error instanceof Error &&
    'query' in error &&
    'params' in error &&
    typeof error.query === 'string'
  );
}

const TRPC_4XX_CODES = new Set([
  'BAD_REQUEST',
  'UNAUTHORIZED',
  'PAYMENT_REQUIRED',
  'FORBIDDEN',
  'NOT_FOUND',
  'METHOD_NOT_SUPPORTED',
  'TIMEOUT',
  'CONFLICT',
  'PRECONDITION_FAILED',
  'PAYLOAD_TOO_LARGE',
  'UNPROCESSABLE_CONTENT',
  'TOO_MANY_REQUESTS',
  'CLIENT_CLOSED_REQUEST',
]);

function isTRPC4xxError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    TRPC_4XX_CODES.has(error.code)
  );
}

if (process.env.NODE_ENV !== 'development') {
  init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,

    // Define how likely traces are sampled. Adjust this value in production, or use tracesSampler for greater control.
    tracesSampleRate: 0.05,

    // Setting this option to true will print useful information to the console while you're setting up Sentry.
    debug: false,
    normalizeDepth: 5,

    // Skip Sentry's OTEL setup because we are using Vercel's OTEL with SentrySpanProcessor
    skipOpenTelemetrySetup: true,

    integrations: [
      // Keep Sentry's httpIntegration for correct request isolation, but do not
      // emit spans here because tracing spans are produced by Vercel's OTel.
      httpIntegration({ spans: false }),
      // send console.log, console.error, and console.warn calls as logs to Sentry
      consoleLoggingIntegration({ levels: ['log', 'error', 'warn'] }),
    ],

    beforeSend(event, hint) {
      const error = hint.originalException;
      if (isTRPC4xxError(error)) {
        return null;
      }

      // Drizzle Queries are wrapped and that prevents Sentry from properly grouping them
      if (isDrizzleQueryError(error)) {
        const pgCode = error.cause?.code;
        event.fingerprint = [
          'drizzle-query-error',
          pgCode ?? 'generic',
          error.cause?.message ?? 'generic',
        ];
        event.tags = {
          ...event.tags,
          'db.error_code': pgCode,
        };
      }
      return event;
    },
  });
}
