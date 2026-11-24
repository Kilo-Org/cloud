/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-known-value-widening
 * -- a Sentry transaction and its spans are external and arbitrarily shaped,
 * the scrubber must never throw on a malformed shape, and span data is an open
 * attribute map. */

import { stripQueryString } from '@/lib/telemetry/request-target';
import { scrubEvent } from '@/lib/telemetry/sentry-scrub';
import { isAllowedRequestHeader } from '@/lib/telemetry/sentry-scrub-request';

/** Span attributes whose value is a URL; each keeps only origin and path. */
const URL_ATTRIBUTES: ReadonlySet<string> = new Set(['url', 'http.url', 'url.full', 'http.target']);

/** Span attributes that carry only a query string or a fragment. */
const QUERY_ATTRIBUTES: ReadonlySet<string> = new Set([
  'http.query',
  'url.query',
  'http.fragment',
  'url.fragment',
]);

const REQUEST_HEADER_PREFIX = 'http.request.header.';
const RESPONSE_HEADER_PREFIX = 'http.response.header.';

function isDroppedSpanAttribute(key: string): boolean {
  if (QUERY_ATTRIBUTES.has(key) || key.startsWith(RESPONSE_HEADER_PREFIX)) {
    return true;
  }
  return (
    key.startsWith(REQUEST_HEADER_PREFIX) &&
    !isAllowedRequestHeader(key.slice(REQUEST_HEADER_PREFIX.length))
  );
}

type SpanData = Record<string, unknown>;

function scrubSpanData(data: SpanData): SpanData {
  const result: SpanData = {};
  for (const [key, value] of Object.entries(data)) {
    if (URL_ATTRIBUTES.has(key)) {
      result[key] = typeof value === 'string' ? stripQueryString(value) : '';
    } else if (!isDroppedSpanAttribute(key)) {
      result[key] = value;
    }
  }
  return result;
}

function scrubSpan(span: unknown): void {
  if (span == null || typeof span !== 'object' || !('data' in span)) {
    return;
  }
  if (span.data != null && typeof span.data === 'object') {
    span.data = scrubSpanData(span.data as SpanData);
  }
}

/**
 * Scrub a Sentry transaction before it is sent: everything {@link scrubEvent}
 * does, plus the root span (`contexts.trace`) and child span attributes. A URL
 * attribute keeps origin and path; query, fragment, response-header and
 * non-allowlisted request-header attributes are dropped.
 */
export function scrubTransactionEvent<T>(event: T): T | null {
  const scrubbed = scrubEvent(event);
  try {
    if (scrubbed == null || typeof scrubbed !== 'object') {
      return scrubbed;
    }
    if (
      'contexts' in scrubbed &&
      scrubbed.contexts != null &&
      typeof scrubbed.contexts === 'object'
    ) {
      scrubSpan((scrubbed.contexts as Record<string, unknown>).trace);
    }
    if ('spans' in scrubbed && Array.isArray(scrubbed.spans)) {
      for (const span of scrubbed.spans) {
        scrubSpan(span);
      }
    }
    return scrubbed;
  } catch {
    return scrubbed;
  }
}
