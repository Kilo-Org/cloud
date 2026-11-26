import { UTS_EXCHANGE_LIMITS } from '@kilocode/uts-contracts';

/**
 * The broker exchange's limits in each UTS isolate (design 3, "Kilo MCP exchange"): 60 exchanges
 * a minute per subject `sid` and 600 a minute per calling workload, both keyed by verified values
 * (the subject token's `sid`, the STS token's workload). Each is a fixed one-minute window held in
 * isolate memory, not shared across isolates: a caller spread over many UTS isolates can pass
 * either in total, and the identity store's pool and the feed stay the real bounds. A refused
 * attempt counts nothing and costs no SQL or signing.
 */

const WINDOW_MS = 60_000;
/** Each map holds at most this many windows; past it, the oldest window is dropped first. */
const MAX_WINDOWS = 10_000;

export type ExchangeLimit = keyof typeof UTS_EXCHANGE_LIMITS;

type Window = { startedAt: number; count: number };

/** Per isolate: the open windows of each limit, by key. */
export type ExchangeWindows = Record<ExchangeLimit, Map<string, Window>>;

export function newExchangeWindows(): ExchangeWindows {
  return { subject: new Map(), caller: new Map() };
}

/**
 * Null when `key` may exchange now under `limit` (and counts the exchange); otherwise the whole
 * seconds until its window resets, 1 to 60, for `Retry-After`.
 */
export function exchangeRetryAfter(
  windows: ExchangeWindows,
  limit: ExchangeLimit,
  key: string,
  now: number
): number | null {
  const open = windows[limit];
  const current = open.get(key);
  if (current === undefined || now - current.startedAt >= WINDOW_MS) {
    open.delete(key);
    if (open.size >= MAX_WINDOWS) {
      const oldest = open.keys().next();
      if (!oldest.done) open.delete(oldest.value);
    }
    open.set(key, { startedAt: now, count: 1 });
    return null;
  }
  if (current.count < UTS_EXCHANGE_LIMITS[limit]) {
    current.count += 1;
    return null;
  }
  return Math.min(60, Math.max(1, Math.ceil((current.startedAt + WINDOW_MS - now) / 1000)));
}
