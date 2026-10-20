// Sentry initialization for the Node.js server runtime of apps/web and apps/ai-gateway.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/
// But note tricky corner cases using vercel otel with sentry:
// https://docs.sentry.io/platforms/javascript/guides/nextjs/opentelemetry/custom-setup/

import type { Event } from '@sentry/nextjs';
import { consoleLoggingIntegration, httpIntegration, init } from '@sentry/nextjs';
import {
  SENSITIVE_PATHS,
  SENSITIVE_QUERY_PARAMS,
  sanitizeAnalyticsPathname,
} from '@kilocode/web-shared/lib/sanitize-analytics-url';

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

// Sentry's automatic request-data integration can capture credentials from the
// request URL or query string. Request metadata is filtered with the shared
// sensitive-URL policy plus `installState`, which only the server app-flow
// handoff carries. Share tokens in the path are redacted by
// `sanitizeAnalyticsPathname`.
const EXTRA_REDACTED_QUERY_KEYS = new Set(['installstate']);

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
  const key = decodeQueryKey(rawKey).toLowerCase();
  return SENSITIVE_QUERY_PARAMS.has(key) || EXTRA_REDACTED_QUERY_KEYS.has(key);
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
// manually, reuse the same sanitizers, and preserve any fragment. A sensitive
// path keeps no query string, matching the shared policy.
function sanitizeRelativeRequestUrl(url: string): string {
  const hashIndex = url.indexOf('#');
  const fragment = hashIndex === -1 ? '' : url.slice(hashIndex);
  const pathAndQuery = hashIndex === -1 ? url : url.slice(0, hashIndex);
  const queryIndex = pathAndQuery.indexOf('?');
  const path = sanitizeAnalyticsPathname(
    queryIndex === -1 ? pathAndQuery : pathAndQuery.slice(0, queryIndex)
  );
  if (queryIndex === -1 || SENSITIVE_PATHS.has(path)) {
    return `${path}${fragment}`;
  }
  const sanitizedQuery = sanitizeStringQuery(pathAndQuery.slice(queryIndex + 1));
  return sanitizedQuery.length > 0 ? `${path}?${sanitizedQuery}${fragment}` : `${path}${fragment}`;
}

function sanitizeRequestUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.pathname = sanitizeAnalyticsPathname(parsed.pathname);
    if (SENSITIVE_PATHS.has(parsed.pathname)) {
      parsed.search = '';
      return parsed.toString();
    }
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

function requestPathname(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    const hashIndex = url.indexOf('#');
    const withoutFragment = hashIndex === -1 ? url : url.slice(0, hashIndex);
    const queryIndex = withoutFragment.indexOf('?');
    return queryIndex === -1 ? withoutFragment : withoutFragment.slice(0, queryIndex);
  }
}

function emptyQueryString(queryString: SentryQueryString): SentryQueryString {
  if (typeof queryString === 'string') {
    return '';
  }
  if (Array.isArray(queryString)) {
    return [];
  }
  return {};
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
    // A request on a shared policy path keeps no query string, in the URL or
    // in this field.
    const sensitivePath =
      typeof request.url === 'string' && SENSITIVE_PATHS.has(requestPathname(request.url));
    request.query_string = sensitivePath
      ? emptyQueryString(request.query_string)
      : sanitizeQueryString(request.query_string);
  }
  return event;
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

      // Automatic request data can retain credentials in the request URL or
      // query string; sanitize it with the shared sensitive-URL policy while
      // keeping the rest.
      sanitizeSentryRequestData(event);

      return event;
    },
  });
}
