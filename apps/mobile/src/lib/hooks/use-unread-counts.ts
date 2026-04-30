import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { useTRPC } from '@/lib/trpc';

/**
 * Fetches per-channel unread message counts for the current user and returns
 * a Map keyed by sandboxId for O(1) lookup from dashboard cards. Badge buckets
 * use the format `kiloclaw:{sandboxId}:{conversationId}`; counts are summed
 * across all conversations belonging to the same sandbox.
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

  const byChannel = useMemo(() => {
    const map = new Map<string, number>();
    for (const row of query.data ?? []) {
      // Badge buckets: `kiloclaw:{sandboxId}:{conversationId}`
      const parts = row.badgeBucket.split(':');
      const sandboxId = parts.length >= 2 ? parts[1] : row.badgeBucket;
      if (sandboxId) {
        map.set(sandboxId, (map.get(sandboxId) ?? 0) + row.badgeCount);
      }
    }
    return map;
  }, [query.data]);

  return { byChannel, query };
}
