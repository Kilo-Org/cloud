import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { useCurrentUserId } from '@/components/kilo-chat/hooks/use-current-user-id';
import { useKiloChatTokenGetter } from '@/components/kilo-chat/hooks/use-kilo-chat-token';
import { NOTIFICATIONS_URL } from '@/lib/config';

type Bucket = { badgeBucket: string; badgeCount: number };

/**
 * Fetches per-channel unread message counts for the current user from the
 * notifications worker and returns a Map keyed by sandboxId for O(1) lookup
 * from dashboard cards. Badge buckets use the format
 * `kiloclaw:{sandboxId}:{conversationId}`; counts are summed across all
 * conversations belonging to the same sandbox.
 *
 * Freshness is driven by invalidations, not polling:
 *   - Foreground chat push → invalidate (see `use-unread-counts-invalidation`).
 *   - App returns to active → invalidate.
 *   - `useMarkRead` optimistically clears the relevant row.
 */
export function useUnreadCounts() {
  const userId = useCurrentUserId();
  const getToken = useKiloChatTokenGetter();

  const query = useQuery<Bucket[]>({
    queryKey: ['badges', userId],
    enabled: userId !== null,
    staleTime: 30_000,
    queryFn: async () => {
      const token = await getToken();
      const response = await fetch(`${NOTIFICATIONS_URL}/v1/badges`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) {
        throw new Error(`Failed to fetch badges: ${response.status}`);
      }
      const body = (await response.json()) as { buckets: Bucket[] };
      return body.buckets;
    },
  });

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
