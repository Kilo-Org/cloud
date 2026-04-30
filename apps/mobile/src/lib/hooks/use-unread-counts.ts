import { useQuery } from '@tanstack/react-query';
import * as Notifications from 'expo-notifications';
import { useMemo } from 'react';

import { type ListBadgesResponse, listBadgesResponseSchema } from '@kilocode/notifications';

import { useCurrentUserId } from '@/components/kilo-chat/hooks/use-current-user-id';
import { useKiloChatTokenGetter } from '@/components/kilo-chat/hooks/use-kilo-chat-token';
import { NOTIFICATIONS_URL } from '@/lib/config';
import { syncDeviceBadgeCountFromBadges } from './badge-count-sync';

/**
 * Fetches unread message counts for the current user from the notifications
 * worker and returns a Map keyed by sandboxId for O(1) lookup from dashboard
 * cards. The notifications worker owns aggregation across conversation rows.
 *
 * Freshness is driven by invalidations, not polling:
 *   - Foreground chat push → invalidate (see `use-unread-counts-invalidation`).
 *   - App returns to active → invalidate.
 *   - `useMarkRead` optimistically clears the relevant row.
 */
export function useUnreadCounts() {
  const userId = useCurrentUserId();
  const getToken = useKiloChatTokenGetter();

  const query = useQuery<ListBadgesResponse>({
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
      const badges = listBadgesResponseSchema.parse(await response.json());
      await syncDeviceBadgeCountFromBadges(badges, Notifications.setBadgeCountAsync);
      return badges;
    },
  });

  const bySandboxId = useMemo(() => {
    const map = new Map<string, number>();
    for (const row of query.data?.instances ?? []) {
      map.set(row.sandboxId, row.unreadCount);
    }
    return map;
  }, [query.data]);

  return { bySandboxId, query };
}
