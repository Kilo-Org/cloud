import { useSyncExternalStore } from 'react';

import { getNowTicker } from '@/lib/hooks/now-ticker-store';

/**
 * How often a relative-time label is re-read while its surface stays open.
 * Minute granularity is the finest a `timeAgo` label resolves above the
 * "just now" bucket, and one interval value means every relative-time surface
 * shares one ticker: two screens subscribing through `useRelativeTimeNow` read
 * the identical instant, so a list row and a detail row never disagree at a
 * bucket edge.
 */
const RELATIVE_TIME_TICK_MS = 60_000;

export function useNowTicker(intervalMs: number): number {
  const ticker = getNowTicker(intervalMs);
  return useSyncExternalStore(ticker.subscribe, ticker.getSnapshot);
}

/**
 * The clock for a relative-time label. Pass the returned instant to
 * `timeAgo(date, locale, now)` instead of letting the formatter read
 * `Date.now()`: React Compiler memoizes render expressions against their traced
 * inputs, so an untracked clock is cached with the row's unchanged props and the
 * on-screen text freezes (see `timeAgo` in `@/lib/utils`).
 */
export function useRelativeTimeNow(): number {
  return useNowTicker(RELATIVE_TIME_TICK_MS);
}
