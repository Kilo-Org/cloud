/* oxlint-disable anti-slop/no-runtime-typeof -- a Sentry event's `request`
 * is external and arbitrarily shaped, and the scrubber must never throw on a
 * malformed shape. */

import { stripQueryString } from '@/lib/telemetry/request-target';

/** The request headers an event keeps; matched case-insensitively. */
const REQUEST_HEADER_ALLOWLIST: ReadonlySet<string> = new Set([
  'accept',
  'content-type',
  'user-agent',
]);

/** True when a request header with this name may leave the device. */
export function isAllowedRequestHeader(name: string): boolean {
  return REQUEST_HEADER_ALLOWLIST.has(name.toLowerCase());
}

/** The only `request` fields an event keeps. */
type ScrubbedRequest = {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
};

function scrubHeaders(headers: unknown): Record<string, string> | undefined {
  if (headers == null || typeof headers !== 'object' || Array.isArray(headers)) {
    return undefined;
  }
  return Object.fromEntries(
    Object.entries(headers).filter(
      (entry): entry is [string, string] =>
        isAllowedRequestHeader(entry[0]) && typeof entry[1] === 'string'
    )
  );
}

/**
 * The scrubbed copy of a Sentry event's `request`: a string `method`, `url`
 * reduced to origin and path, and the {@link REQUEST_HEADER_ALLOWLIST} headers
 * with string values. Every other field (`cookies`, `data`, `query_string`,
 * `env`) is dropped.
 */
export function scrubRequest(req: Record<string, unknown>): ScrubbedRequest {
  const scrubbed: ScrubbedRequest = {};
  if (typeof req.method === 'string') {
    scrubbed.method = req.method;
  }
  if ('url' in req) {
    scrubbed.url = typeof req.url === 'string' ? stripQueryString(req.url) : '';
  }
  const headers = scrubHeaders(req.headers);
  if (headers !== undefined) {
    scrubbed.headers = headers;
  }
  return scrubbed;
}
