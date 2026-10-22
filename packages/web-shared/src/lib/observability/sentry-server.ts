// Sentry initialization for the Node.js server runtime of apps/web and apps/ai-gateway.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/
// But note tricky corner cases using vercel otel with sentry:
// https://docs.sentry.io/platforms/javascript/guides/nextjs/opentelemetry/custom-setup/

import { consoleLoggingIntegration, httpIntegration, init } from '@sentry/nextjs';
import { RESTRICTED_DATA_COLLECTION } from '@kilocode/web-shared/lib/observability/sentry-data-collection';
import { sanitizeSentryRequestData } from '@kilocode/web-shared/lib/observability/sentry-request-data';

export { sanitizeSentryRequestData };

type DrizzleQueryError = Error & {
  query: string;
  params: unknown[];
  cause?: { code?: string; message?: string; name?: string; constructor?: { name?: string } };
};

const GENERIC_ERROR_TYPE_NAMES = new Set(['Error', 'error']);

function isDrizzleQueryError(error: unknown): error is DrizzleQueryError {
  return (
    error instanceof Error &&
    'query' in error &&
    'params' in error &&
    typeof error.query === 'string'
  );
}

function causeTypeName(cause: NonNullable<DrizzleQueryError['cause']>): string {
  if (typeof cause.code === 'string' && /^[A-Z0-9]{5}$/.test(cause.code)) {
    return 'PostgresError';
  }

  if (
    typeof cause.name === 'string' &&
    cause.name.length > 0 &&
    !GENERIC_ERROR_TYPE_NAMES.has(cause.name)
  ) {
    return cause.name;
  }

  const ctorName = cause.constructor?.name;
  if (
    typeof ctorName === 'string' &&
    ctorName.length > 0 &&
    ctorName !== 'Object' &&
    !GENERIC_ERROR_TYPE_NAMES.has(ctorName)
  ) {
    return ctorName;
  }

  return 'DatabaseError';
}

function isDrizzleWrapperException(value: { value?: string }): boolean {
  return typeof value.value === 'string' && value.value.startsWith('Failed query:');
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

export function initServerSentry(): void {
  if (process.env.NODE_ENV === 'development') {
    return;
  }

  init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,

    // Tracing is fully disabled.
    tracesSampleRate: 0,

    // Setting this option to true will print useful information to the console while you're setting up Sentry.
    debug: false,
    normalizeDepth: 5,

    // The Vercel OTel setup in node-instrumentation.ts owns the tracer provider, so Sentry
    // must not install one of its own.
    enableOpenTelemetrySetup: false,

    dataCollection: RESTRICTED_DATA_COLLECTION,

    integrations: [
      // Keep Sentry's httpIntegration for correct request isolation. It emits no spans
      // because Sentry tracing is disabled.
      httpIntegration({ spans: false }),
      // send console.log, console.error, and console.warn calls as logs to Sentry
      consoleLoggingIntegration({ levels: ['log', 'error', 'warn'] }),
    ],

    beforeSend(event, hint) {
      const error = hint.originalException;
      if (isTRPC4xxError(error)) {
        return null;
      }

      // Drizzle wraps query errors with a `Failed query: <unique SQL>` message,
      // which breaks Sentry grouping and hides the real root cause (e.g. a
      // "statement timeout" on `error.cause`). Rewrite the primary exception so
      // the reported error reflects the underlying cause, and move the failed
      // query into a context so it stays visible on the issue without polluting
      // the title or fingerprint.
      if (isDrizzleQueryError(error)) {
        const cause = error.cause;
        const pgCode = cause?.code;
        event.fingerprint = [
          'drizzle-query-error',
          pgCode ?? 'generic',
          cause?.message ?? 'generic',
        ];
        event.tags = {
          ...event.tags,
          'db.error_code': pgCode,
        };
        event.contexts = {
          ...event.contexts,
          drizzle_query: {
            query: error.query,
            wrapper_message: error.message,
          },
        };

        if (cause) {
          // Prefer the Drizzle wrapper so we keep the stack that points through
          // our code, then drop serialized cause entries because they duplicate
          // the rewritten primary exception.
          const values = event.exception?.values;
          if (values && values.length > 0) {
            const primaryException =
              values.find(isDrizzleWrapperException) ?? values[values.length - 1];
            primaryException.type = causeTypeName(cause);
            primaryException.value = cause.message ?? 'unknown database error';
            event.exception = {
              ...event.exception,
              values: [primaryException],
            };
          }
        }
      }

      // Automatic request data can retain the GitHub OAuth `state` token, the
      // app-flow `installState` bearer, or a `/s/{jwt}` share token; strip them
      // while keeping the rest.
      sanitizeSentryRequestData(event);

      return event;
    },
  });
}
