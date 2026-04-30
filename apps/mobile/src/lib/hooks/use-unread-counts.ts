import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { badgeBucketForInstance } from '@/lib/badge-buckets';
import { useTRPC } from '@/lib/trpc';

/**
 * Fetches unread message counts for the current user and returns a Map keyed by
 * instance badge bucket for O(1) lookup from dashboard cards. Conversation
 * buckets are summed into their parent instance bucket.
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

  const byBadgeBucket = useMemo(() => {
    const map = new Map<string, number>();
    for (const row of query.data ?? []) {
      const parts = row.badgeBucket.split(':');
      const aggregateBucket =
        parts[0] === 'kiloclaw' && parts[1] ? badgeBucketForInstance(parts[1]) : row.badgeBucket;
      map.set(aggregateBucket, (map.get(aggregateBucket) ?? 0) + row.badgeCount);
    }
    return map;
  }, [query.data]);

  return { byBadgeBucket, query };
}
