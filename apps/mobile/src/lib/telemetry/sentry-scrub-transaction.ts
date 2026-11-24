/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-known-value-widening
 * -- a Sentry transaction and its spans are external and arbitrarily shaped,
 * the scrubber must never throw on a malformed shape, and span data is an open
 * attribute map. */

import { scrubEvent } from '@/lib/telemetry/sentry-scrub';
import { isAllowedRequestHeader } from '@/lib/telemetry/sentry-scrub-request';
import { redactSharePaths, scrubUrl } from '@/lib/telemetry/sentry-url-policy';

/** Span attributes whose value is a URL or a path; each goes through {@link scrubUrl}. */
const URL_ATTRIBUTES: ReadonlySet<string> = new Set([
  'url',
  'http.url',
  'url.full',
  'http.target',
  'url.path',
  'deeplink.url',
]);

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
      result[key] = scrubUrl(value);
    } else if (!isDroppedSpanAttribute(key)) {
      result[key] = typeof value === 'string' ? redactSharePaths(value) : value;
    }
  }
  return result;
}

function scrubSpan(span: unknown): void {
  if (span == null || typeof span !== 'object') {
    return;
  }
  const record = span as Record<string, unknown>;
  if (typeof record.description === 'string') {
    record.description = redactSharePaths(record.description);
  }
  if (record.data != null && typeof record.data === 'object') {
    record.data = scrubSpanData(record.data as SpanData);
  }
}

/**
 * Scrub a Sentry transaction before it is sent: everything {@link scrubEvent}
 * does, plus the transaction name, the root span (`contexts.trace`), and child
 * spans. A URL attribute goes through {@link scrubUrl}; the name, span
 * descriptions, and other string attributes lose share-link credentials; query,
 * fragment, response-header and non-allowlisted request-header attributes are
 * dropped.
 */
export function scrubTransactionEvent<T>(event: T): T | null {
  const scrubbed = scrubEvent(event);
  try {
    if (scrubbed == null || typeof scrubbed !== 'object') {
      return scrubbed;
    }
    if ('transaction' in scrubbed && typeof scrubbed.transaction === 'string') {
      scrubbed.transaction = redactSharePaths(scrubbed.transaction);
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
