// Request-data policy shared by the Node.js and edge Sentry initializers.
// Keep this module usable from an edge runtime: it imports no SDK runtime
// values and no Node builtins, so the SDK import below stays type-only.

import type { Event } from '@sentry/nextjs';
import {
  SENSITIVE_PATHS,
  SENSITIVE_QUERY_PARAMS,
  sanitizeAnalyticsPathname,
} from '@kilocode/web-shared/lib/sanitize-analytics-url';
import { FILTERED_VALUE } from '@kilocode/web-shared/lib/observability/sentry-secret-patterns';

// Query keys covered by the shared URL policy, plus the handoff key that only
// this request carries. The rest of the request is kept.
const EXTRA_REDACTED_QUERY_KEYS = new Set(['installstate']);

// Decode a raw query component the way URLSearchParams would, so
// percent-encoded forms are compared against their decoded value. Malformed
// percent-encoding is left in its raw form.
function decodeQueryComponent(raw: string): string {
  try {
    return decodeURIComponent(raw.replace(/\+/g, ' '));
  } catch {
    return raw;
  }
}

// A value that holds its own query, such as `callbackPath=/pages-auth?state=...`,
// carries the parameters of another URL. Their names are unknown here, so the
// whole value is dropped rather than parsed against the key deny list.
const NESTED_QUERY_VALUE = /[?&=]/;

// One predicate for every query form: URL, string, array, and object. Keys are
// matched after URL-decoding and case-folding.
function isRedactedQueryParam(rawKey: string, rawValue: string): boolean {
  const key = decodeQueryComponent(rawKey).toLowerCase();
  return (
    SENSITIVE_QUERY_PARAMS.has(key) ||
    EXTRA_REDACTED_QUERY_KEYS.has(key) ||
    NESTED_QUERY_VALUE.test(decodeQueryComponent(rawValue))
  );
}

type SentryRequest = NonNullable<Event['request']>;
type SentryQueryString = NonNullable<SentryRequest['query_string']>;
type SentryHeaders = NonNullable<SentryRequest['headers']>;

// The proxy forwards the request pathname in this header, so its value follows
// the same policy as the URL. The forwarded query (`x-search`) is not allowed:
// the URL and query string already carry it after the query policy.
const PATHNAME_HEADER = 'x-pathname';
const REFERER_HEADER = 'referer';

// An allowlist, because a deny list misses every new header name that carries a
// credential, such as x-vercel-sc-headers. The SDK collection policy reads the
// same list, so both layers keep the same headers.
export const SENTRY_REQUEST_HEADER_ALLOWLIST: readonly string[] = [
  'accept',
  'accept-encoding',
  'accept-language',
  'content-type',
  'content-length',
  'host',
  'user-agent',
  REFERER_HEADER,
  'origin',
  PATHNAME_HEADER,
  'x-vercel-id',
  'x-request-id',
  'x-matched-path',
  'x-forwarded-host',
  'x-forwarded-proto',
  'traceparent',
];

const ALLOWED_HEADERS = new Set(SENTRY_REQUEST_HEADER_ALLOWLIST);

function sanitizeStringQuery(queryString: string): string {
  return queryString
    .split('&')
    .filter(part => {
      const separator = part.indexOf('=');
      return separator === -1
        ? !isRedactedQueryParam(part, '')
        : !isRedactedQueryParam(part.slice(0, separator), part.slice(separator + 1));
    })
    .join('&');
}

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
    for (const [key, value] of Array.from(parsed.searchParams)) {
      if (isRedactedQueryParam(key, value)) {
        parsed.searchParams.delete(key);
      }
    }
    return parsed.toString();
  } catch {
    return sanitizeRelativeRequestUrl(url);
  }
}

function sanitizeHeaders(headers: SentryHeaders): void {
  for (const name of Object.keys(headers)) {
    const lowerName = name.toLowerCase();
    if (!ALLOWED_HEADERS.has(lowerName)) {
      headers[name] = FILTERED_VALUE;
    } else if (lowerName === REFERER_HEADER) {
      headers[name] = sanitizeRequestUrl(headers[name]);
    } else if (lowerName === PATHNAME_HEADER) {
      headers[name] = sanitizeAnalyticsPathname(headers[name]);
    }
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
    return queryString.filter(([key, value]) => !isRedactedQueryParam(key, value));
  }
  const kept: Record<string, string> = {};
  for (const [key, value] of Object.entries(queryString)) {
    if (!isRedactedQueryParam(key, value)) {
      kept[key] = value;
    }
  }
  return kept;
}

// captureRequestError from @sentry/nextjs puts the request path, with its query,
// into this context. It is the only context field the SDK fills from the URL.
function sanitizeNextjsContext(event: Event): void {
  const nextjs = event.contexts?.nextjs;
  if (nextjs && typeof nextjs.request_path === 'string') {
    nextjs.request_path = sanitizeRequestUrl(nextjs.request_path);
  }
}

export function sanitizeSentryRequestData(event: Event): Event {
  sanitizeNextjsContext(event);
  const request = event.request;
  if (!request) {
    return event;
  }
  const sensitivePath =
    typeof request.url === 'string' && SENSITIVE_PATHS.has(requestPathname(request.url));
  if (typeof request.url === 'string') {
    request.url = sanitizeRequestUrl(request.url);
  }
  if (request.query_string !== undefined) {
    request.query_string = sensitivePath
      ? emptyQueryString(request.query_string)
      : sanitizeQueryString(request.query_string);
  }
  if (request.headers) {
    sanitizeHeaders(request.headers);
  }
  delete request.cookies;
  delete request.data;
  return event;
}
