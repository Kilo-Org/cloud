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

/**
 * Scrub a Sentry event's `request` in place: reduce `url` to origin and path,
 * delete `cookies`, `data` and `query_string`, and keep only the
 * {@link REQUEST_HEADER_ALLOWLIST} headers.
 */
export function scrubRequest(req: Record<string, unknown>): void {
  if ('url' in req) {
    req.url = typeof req.url === 'string' ? stripQueryString(req.url) : '';
  }
  delete req.cookies;
  delete req.data;
  delete req.query_string;
  if (req.headers != null && typeof req.headers === 'object') {
    req.headers = Object.fromEntries(
      Object.entries(req.headers).filter(([name]) =>
        REQUEST_HEADER_ALLOWLIST.has(name.toLowerCase())
      )
    );
  }
}
