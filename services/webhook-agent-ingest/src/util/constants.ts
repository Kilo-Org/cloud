/**
 * Shared constants for the webhook agent
 */

/** Maximum payload size for webhook requests (256KB) */
export const MAX_PAYLOAD_SIZE = 256 * 1024;

/** Maximum number of requests to retain per trigger */
export const MAX_REQUESTS = 100;

/** Maximum number of in-flight requests per trigger */
export const MAX_INFLIGHT_REQUESTS = 20;

/** Default request limit for list queries */
export const DEFAULT_REQUEST_LIMIT = 50;

/** Maximum request limit for list queries */
export const MAX_REQUEST_LIMIT = 200;

/**
 * Clamp a request limit to valid bounds.
 * Accepts either a number or a string (from query params).
 * Returns DEFAULT_REQUEST_LIMIT if input is undefined/null.
 */
export function clampRequestLimit(limit: number | string | undefined | null): number {
  if (limit === undefined || limit === null) {
    return DEFAULT_REQUEST_LIMIT;
  }

  const parsed = typeof limit === 'string' ? Number.parseInt(limit, 10) : limit;

  if (!Number.isFinite(parsed) || parsed < 1) {
    return 1;
  }

  return Math.min(parsed, MAX_REQUEST_LIMIT);
}
