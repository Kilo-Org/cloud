/**
 * How many attempts one session makes before it stops retrying by itself, so a
 * server that keeps dropping the connection is not hammered indefinitely. The
 * closed state still offers Retry: this caps the automatic attempts, not the
 * person's.
 */
export const MAX_RECONNECT_ATTEMPTS = 5;

const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30_000;

/** The wait before attempt `attempt` (1-based): one second, doubling, capped. */
export function reconnectDelayMs(attempt: number): number {
  return Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1));
}
