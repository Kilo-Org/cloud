// Sentry initialization for the Node.js server runtime of apps/web and apps/ai-gateway.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/
// But note tricky corner cases using vercel otel with sentry:
// https://docs.sentry.io/platforms/javascript/guides/nextjs/opentelemetry/custom-setup/

import { httpIntegration, init } from '@sentry/nextjs';
import { RESTRICTED_DATA_COLLECTION } from '@kilocode/web-shared/lib/observability/sentry-data-collection';
import {
  dropTraceTransactionName,
  scrubSentryBreadcrumb,
  scrubSentryEvent,
} from '@kilocode/web-shared/lib/observability/sentry-event-scrub';

export { sanitizeSentryRequestData } from '@kilocode/web-shared/lib/observability/sentry-request-data';

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

function findDrizzleQueryError(error: unknown): DrizzleQueryError | undefined {
  const seen = new Set<Error>();
  while (error instanceof Error && !seen.has(error)) {
    if (isDrizzleQueryError(error)) {
      return error;
    }
    seen.add(error);
    error = error.cause;
  }
  return undefined;
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

// Postgres quotes input values in its messages (`invalid input syntax for type
// uuid: "..."`) and can append a key detail (`Key (email)=(...)`). Quoted
// identifiers such as constraint names are filtered too.
function withoutDatabaseInput(message: string): string {
  return message
    .replace(/"[^"]*"/g, '"[Filtered]"')
    .replace(/\(([^()]*)\)=\([^()]*\)/g, '($1)=([Filtered])');
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

  const client = init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,

    // Tracing is fully disabled.
    tracesSampleRate: 0,
    // An incoming `sentry-trace` header with a positive decision outranks the
    // rate; a sampler outranks the header, so no transaction or span is built.
    // Spans stream by default and skip beforeSend, so every span name is also
    // ignored in case one is still started.
    tracesSampler: () => 0,
    ignoreSpans: [/.*/],

    // Setting this option to true will print useful information to the console while you're setting up Sentry.
    debug: false,
    normalizeDepth: 5,

    // SDK 11 attaches a synthetic stack trace to captureMessage events by default, which
    // groups them by minified call site instead of by message and splits every existing
    // message issue into new ones.
    attachStacktrace: false,

    // The Vercel OTel setup in node-instrumentation.ts owns the tracer provider, so Sentry
    // must not install one of its own.
    enableOpenTelemetrySetup: false,

    dataCollection: RESTRICTED_DATA_COLLECTION,

    // No consoleLoggingIntegration: the SDK formats console arguments into the log
    // body before beforeSendLog runs, so the body keeps any credential passed as an
    // argument and no hook can scrub it reliably.
    integrations: [
      // Keep Sentry's httpIntegration for correct request isolation. It emits no spans
      // because Sentry tracing is disabled.
      httpIntegration({ spans: false }),
    ],

    beforeSend(event, hint) {
      if (isTRPC4xxError(hint.originalException)) {
        return null;
      }

      // Drizzle wraps query errors with a `Failed query: <SQL>\nparams: <values>`
      // message, which breaks Sentry grouping, carries the bound values (tokens,
      // emails) and hides the real root cause (e.g. a "statement timeout" on
      // `error.cause`). Rewrite the primary exception so the reported error
      // reflects the cause without input values, keep only the parameterized
      // query in a context, and group by SQLSTATE and cause type.
      const error = findDrizzleQueryError(hint.originalException);
      if (error) {
        const cause = error.cause;
        const pgCode = cause?.code;
        event.fingerprint = [
          'drizzle-query-error',
          pgCode ?? 'generic',
          cause ? causeTypeName(cause) : 'DrizzleQueryError',
        ];
        event.tags = {
          ...event.tags,
          'db.error_code': pgCode,
        };
        event.contexts = {
          ...event.contexts,
          drizzle_query: { query: error.query },
        };

        // Prefer the Drizzle wrapper so we keep the stack that points through
        // our code, then drop serialized cause entries because they duplicate
        // the rewritten primary exception.
        const values = event.exception?.values;
        if (values && values.length > 0) {
          const rootException = values[values.length - 1];
          const primaryException = values.find(isDrizzleWrapperException) ?? rootException;
          if (primaryException !== rootException) {
            primaryException.mechanism = rootException.mechanism;
          }
          if (cause) {
            primaryException.type = causeTypeName(cause);
            primaryException.value = withoutDatabaseInput(
              cause.message ?? 'unknown database error'
            );
          } else {
            primaryException.value = `Failed query: ${error.query}`;
          }
          event.exception = {
            ...event.exception,
            values: [primaryException],
          };
        }
      }

      return scrubSentryEvent(event);
    },

    beforeBreadcrumb: scrubSentryBreadcrumb,
  });
  client?.on('createDsc', dropTraceTransactionName);
}
