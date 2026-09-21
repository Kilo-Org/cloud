import { useSyncExternalStore } from 'react';

import { getNowTicker } from '@/lib/hooks/now-ticker-store';

export function useNowTicker(intervalMs: number): number {
  const ticker = getNowTicker(intervalMs);
  return useSyncExternalStore(ticker.subscribe, ticker.getSnapshot);
}
