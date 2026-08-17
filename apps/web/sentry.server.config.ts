// This file configures the initialization of Sentry on the server.
// The config you add here will be used whenever the server handles a request.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/
// But note tricky corner cases using vercel otel with sentry:
// https://docs.sentry.io/platforms/javascript/guides/nextjs/opentelemetry/custom-setup/

import type { Event } from '@sentry/nextjs';
import { consoleLoggingIntegration, httpIntegration, init } from '@sentry/nextjs';

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

// The AI gateway returns 402 when the caller's own credit balance is exhausted
// (`usage_limit_exceeded`, "Add credits to continue, or switch to a free
// model"), and the AI SDK surfaces that as AI_APICallError with statusCode 402
// (e.g. Kilo Bot calling the gateway on behalf of a user who is out of
// credits). That is expected per-user billing state, not an application bug.
// Upstream provider 402s (our provider account) never reach callers: the
// gateway converts them to a 503 and reports them itself via
// captureProxyError. Duck-typed like isTRPC4xxError to keep the `ai` package
// out of the Sentry init bundle.
export function isAIUsageLimitError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.name === 'AI_APICallError' &&
    'statusCode' in error &&
    error.statusCode === 402
  );
}

// The GitHub OAuth callback uses `state` as a short-lived bearer token, and the
// mobile app handoff carries a C1 bearer in `installState`. Sentry's automatic
// request-data integration can capture either in the request URL or query
// string, so strip both from both while keeping the rest of the request data.
const REDACTED_QUERY_KEYS = new Set(['state', 'installState'].map(key => key.toLowerCase()));

// Decode a raw query key the way URLSearchParams would, so percent-encoded
// forms of the key are compared against their decoded value. Malformed
// percent-encoding is not the redacted key and is left in its raw form.
function decodeQueryKey(rawKey: string): string {
  try {
    return decodeURIComponent(rawKey.replace(/\+/g, ' '));
  } catch {
    return rawKey;
  }
}

// One decoded-key predicate for every query form: URL, string, array, and
// object. Keys are matched after URL-decoding and case-folding so percent-
// encoded (`%73tate`) and mixed-case (`State`) forms cannot survive.
function isRedactedQueryKey(rawKey: string): boolean {
  return REDACTED_QUERY_KEYS.has(decodeQueryKey(rawKey).toLowerCase());
}

type SentryRequest = NonNullable<Event['request']>;
type SentryQueryString = NonNullable<SentryRequest['query_string']>;

function sanitizeStringQuery(queryString: string): string {
  return queryString
    .split('&')
    .filter(part => !isRedactedQueryKey(part.split('=', 1)[0]))
    .join('&');
}

// Relative URLs cannot be parsed with `new URL`; split off the query string
// manually, reuse the same sanitizer, and preserve any fragment.
function sanitizeRelativeRequestUrl(url: string): string {
  const hashIndex = url.indexOf('#');
  const fragment = hashIndex === -1 ? '' : url.slice(hashIndex);
  const pathAndQuery = hashIndex === -1 ? url : url.slice(0, hashIndex);
  const queryIndex = pathAndQuery.indexOf('?');
  if (queryIndex === -1) {
    return url;
  }
  const path = pathAndQuery.slice(0, queryIndex);
  const sanitizedQuery = sanitizeStringQuery(pathAndQuery.slice(queryIndex + 1));
  return sanitizedQuery.length > 0 ? `${path}?${sanitizedQuery}${fragment}` : `${path}${fragment}`;
}

function sanitizeRequestUrl(url: string): string {
  try {
    const parsed = new URL(url);
    for (const [key] of Array.from(parsed.searchParams)) {
      if (isRedactedQueryKey(key)) {
        parsed.searchParams.delete(key);
      }
    }
    return parsed.toString();
  } catch {
    return sanitizeRelativeRequestUrl(url);
  }
}

function sanitizeQueryString(queryString: SentryQueryString): SentryQueryString {
  if (typeof queryString === 'string') {
    return sanitizeStringQuery(queryString);
  }
  if (Array.isArray(queryString)) {
    return queryString.filter(([key]) => !isRedactedQueryKey(key));
  }
  const kept: Record<string, string> = {};
  for (const [key, value] of Object.entries(queryString)) {
    if (!isRedactedQueryKey(key)) {
      kept[key] = value;
    }
  }
  return kept;
}

export function sanitizeSentryRequestData(event: Event): Event {
  const request = event.request;
  if (!request) {
    return event;
  }
  if (typeof request.url === 'string') {
    request.url = sanitizeRequestUrl(request.url);
  }
  if (request.query_string !== undefined) {
    request.query_string = sanitizeQueryString(request.query_string);
  }
  return event;
}

if (process.env.NODE_ENV !== 'development') {
  init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,

    // Tracing is fully disabled.
    tracesSampleRate: 0,

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
      if (isTRPC4xxError(error) || isAIUsageLimitError(error)) {
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

      // Automatic request data can retain the GitHub OAuth `state` token or the
      // app-flow `installState` bearer in the request URL or query string; strip
      // them while keeping the rest.
      sanitizeSentryRequestData(event);

      return event;
    },
  });
}
