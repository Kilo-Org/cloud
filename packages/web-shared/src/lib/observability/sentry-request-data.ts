// Request-data policy shared by the Node.js and edge Sentry initializers.
// Keep this module usable from an edge runtime: it imports no SDK runtime
// values and no Node builtins, so the SDK import below stays type-only.

import type { Event } from '@sentry/nextjs';
import {
  SENSITIVE_PATHS,
  SENSITIVE_QUERY_PARAMS,
  sanitizeAnalyticsPathname,
} from '@kilocode/web-shared/lib/sanitize-analytics-url';

// Query keys covered by the shared URL policy, plus the handoff key that only
// this request carries. The rest of the request is kept.
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
// object. Keys are matched after URL-decoding and case-folding.
function isRedactedQueryKey(rawKey: string): boolean {
  const key = decodeQueryKey(rawKey).toLowerCase();
  return SENSITIVE_QUERY_PARAMS.has(key) || EXTRA_REDACTED_QUERY_KEYS.has(key);
}

type SentryRequest = NonNullable<Event['request']>;
type SentryQueryString = NonNullable<SentryRequest['query_string']>;
type SentryHeaders = NonNullable<SentryRequest['headers']>;

// The proxy forwards the request pathname and query in these headers, so the
// header values follow the same policy as the URL.
const PATHNAME_HEADER = 'x-pathname';
const SEARCH_HEADER = 'x-search';

function sanitizeStringQuery(queryString: string): string {
  return queryString
    .split('&')
    .filter(part => !isRedactedQueryKey(part.split('=', 1)[0]))
    .join('&');
}

function sanitizeForwardedHeaders(headers: SentryHeaders): void {
  const names = Object.keys(headers);
  let sensitivePath = false;
  for (const name of names) {
    if (name.toLowerCase() !== PATHNAME_HEADER) continue;
    const pathname = sanitizeAnalyticsPathname(headers[name]);
    headers[name] = pathname;
    sensitivePath ||= SENSITIVE_PATHS.has(pathname);
  }
  for (const name of names) {
    if (name.toLowerCase() !== SEARCH_HEADER) continue;
    const value = headers[name];
    const prefix = value.startsWith('?') ? '?' : '';
    headers[name] = sensitivePath
      ? ''
      : `${prefix}${sanitizeStringQuery(value.slice(prefix.length))}`;
  }
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
    sanitizeForwardedHeaders(request.headers);
  }
  return event;
}
