import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { useTRPC } from '@/lib/trpc';

/**
 * Fetches per-instance unread message counts for the current user and returns
 * a Map keyed by instanceId for O(1) lookup from dashboard cards.
 *
 * Freshness is driven by invalidations, not polling:
 *   - Foreground chat push → invalidate (see `use-unread-counts-invalidation`).
 *   - App returns to active → invalidate.
 *   - `markChatRead` optimistically clears the relevant row.
 */
export function useUnreadCounts() {
  const trpc = useTRPC();
  const query = useQuery(
    trpc.user.getUnreadCounts.queryOptions(undefined, {
      staleTime: 30_000,
    })
  );

  const byInstance = useMemo(() => {
    const map = new Map<string, number>();
    for (const row of query.data ?? []) {
      map.set(row.instanceId, row.badgeCount);
    }
    return map;
  }, [query.data]);

  return { byInstance, query };
}
