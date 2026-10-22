// Request-data policy shared by the Node.js and edge Sentry initializers.
// Keep this module usable from an edge runtime: it imports no SDK runtime
// values and no Node builtins, so the SDK import below stays type-only.

import type { Event } from '@sentry/nextjs';
import { sanitizeAnalyticsPathname } from '@kilocode/web-shared/lib/sanitize-analytics-url';

// Handoff credential keys are dropped from request data; the rest of the
// request is kept.
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
// object. Keys are matched after URL-decoding and case-folding.
function isRedactedQueryKey(rawKey: string): boolean {
  return REDACTED_QUERY_KEYS.has(decodeQueryKey(rawKey).toLowerCase());
}

type SentryRequest = NonNullable<Event['request']>;
type SentryQueryString = NonNullable<SentryRequest['query_string']>;
type SentryHeaders = NonNullable<SentryRequest['headers']>;

// The proxy forwards the request query in this header, so the header value
// follows the same query policy as the URL.
const SEARCH_HEADER = 'x-search';

function sanitizeStringQuery(queryString: string): string {
  return queryString
    .split('&')
    .filter(part => !isRedactedQueryKey(part.split('=', 1)[0]))
    .join('&');
}

function sanitizeSearchHeaders(headers: SentryHeaders): void {
  for (const name of Object.keys(headers)) {
    if (name.toLowerCase() !== SEARCH_HEADER) {
      continue;
    }
    const value = headers[name];
    const prefix = value.startsWith('?') ? '?' : '';
    headers[name] = `${prefix}${sanitizeStringQuery(value.slice(prefix.length))}`;
  }
}

// Relative URLs cannot be parsed with `new URL`; split off the query string
// manually, reuse the same sanitizer, and preserve any fragment.
function sanitizeRelativeRequestUrl(url: string): string {
  const hashIndex = url.indexOf('#');
  const fragment = hashIndex === -1 ? '' : url.slice(hashIndex);
  const pathAndQuery = hashIndex === -1 ? url : url.slice(0, hashIndex);
  const queryIndex = pathAndQuery.indexOf('?');
  if (queryIndex === -1) {
    return `${sanitizeAnalyticsPathname(pathAndQuery)}${fragment}`;
  }
  const path = sanitizeAnalyticsPathname(pathAndQuery.slice(0, queryIndex));
  const sanitizedQuery = sanitizeStringQuery(pathAndQuery.slice(queryIndex + 1));
  return sanitizedQuery.length > 0 ? `${path}?${sanitizedQuery}${fragment}` : `${path}${fragment}`;
}

function sanitizeRequestUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.pathname = sanitizeAnalyticsPathname(parsed.pathname);
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
  if (request.headers) {
    sanitizeSearchHeaders(request.headers);
  }
  return event;
}
