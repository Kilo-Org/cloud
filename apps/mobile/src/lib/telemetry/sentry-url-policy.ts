/* oxlint-disable anti-slop/no-runtime-typeof -- a URL field in a Sentry
 * payload is external and arbitrarily shaped, and the scrubber must never
 * throw on a malformed shape. */

import { stripQueryString } from '@/lib/telemetry/request-target';

/**
 * A share-link segment and the credential after it: the web `/s/<share JWT>`
 * and legacy `/share/<id>` links, and the app's `/shared/<token>` route they
 * map to (`packages/app-shared` universal links).
 */
const SHARE_PATH_SEGMENT = /(^|[\s/])(s|share|shared)\/[^/?#\s"']+/gu;

/** Replace each share-link credential in a URL, path, or text with `[redacted]`. */
export function redactSharePaths(text: string): string {
  return text.replace(SHARE_PATH_SEGMENT, '$1$2/[redacted]');
}

/**
 * The URL form a Sentry payload carries: origin and path, with share-link
 * credentials redacted. A non-string value becomes an empty string.
 */
export function scrubUrl(url: unknown): string {
  return typeof url === 'string' ? redactSharePaths(stripQueryString(url)) : '';
}
