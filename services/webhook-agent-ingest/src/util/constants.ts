export const MAX_PAYLOAD_SIZE = 256 * 1024;

export const MAX_REQUESTS = 100;

export const MAX_INFLIGHT_REQUESTS = 20;

export const DEFAULT_REQUEST_LIMIT = 50;

export const MAX_REQUEST_LIMIT = 200;

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
