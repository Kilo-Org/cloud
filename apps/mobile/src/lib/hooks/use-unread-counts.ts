import { useQuery } from '@tanstack/react-query';
import * as Notifications from 'expo-notifications';
import { useMemo } from 'react';

import {
  type BadgeCountRow,
  listBadgesResponseSchema,
  parentBadgeBucketFor,
} from '@kilocode/notifications';

import { useCurrentUserId } from '@/components/kilo-chat/hooks/use-current-user-id';
import { useKiloChatTokenGetter } from '@/components/kilo-chat/hooks/use-kilo-chat-token';
import { readBadgeFreshnessEpoch } from '@/lib/badge-freshness';
import { reconcileHydratedBadgeCount } from '@/lib/badge-hydration';
import { NOTIFICATIONS_URL } from '@/lib/config';

/**
 * Fetches unread message counts for the current user from the notifications
 * worker and returns a Map keyed by instance badge bucket for O(1) lookup from
 * dashboard cards. Conversation buckets are summed into their parent instance
 * bucket.
 *
 * Freshness is driven by invalidations, not polling:
 *   - Foreground chat push → invalidate (see `use-unread-counts-invalidation`).
 *   - App returns to active → invalidate.
 *   - `useMarkRead` clears the relevant row after Kilo Chat confirms the bucket clear.
 */
export function useUnreadCounts() {
  const userId = useCurrentUserId();
  const getToken = useKiloChatTokenGetter();

  const query = useQuery<BadgeCountRow[]>({
    queryKey: ['badges', userId],
    enabled: userId !== null,
    staleTime: 30_000,
    queryFn: async () => {
      const startBadgeFreshnessEpoch = readBadgeFreshnessEpoch();
      const token = await getToken();
      const response = await fetch(`${NOTIFICATIONS_URL}/v1/badges`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) {
        throw new Error(`Failed to fetch badges: ${response.status}`);
      }
      const body = listBadgesResponseSchema.parse(await response.json());
      reconcileHydratedBadgeCount({
        badgeRows: body.buckets,
        startBadgeFreshnessEpoch,
        currentBadgeFreshnessEpoch: readBadgeFreshnessEpoch(),
        setBadgeCount: Notifications.setBadgeCountAsync,
      });
      return body.buckets;
    },
  });

  const byBadgeBucket = useMemo(() => {
    const map = new Map<string, number>();
    for (const row of query.data ?? []) {
      const aggregateBucket = parentBadgeBucketFor(row.badgeBucket);
      map.set(aggregateBucket, (map.get(aggregateBucket) ?? 0) + row.badgeCount);
    }
    return map;
  }, [query.data]);

  return { byBadgeBucket, query };
}
