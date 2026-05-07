import { useQueryClient } from '@tanstack/react-query';
import * as Notifications from 'expo-notifications';
import { useEffect } from 'react';
import { AppState } from 'react-native';

import { useCurrentUserId } from '@/components/kilo-chat/hooks/use-current-user-id';
import { advanceBadgeFreshnessEpoch } from '@/lib/badge-freshness';
import { parseNotificationData } from '@/lib/notifications';

/**
 * Keeps the `['badges', userId]` cache in sync with real-time notification
 * traffic so per-instance badges on the dashboard reflect pushes received while
 * the app is open or resumed from background.
 *
 * - Foreground chat push → invalidate (server already incremented the count).
 * - App returns to active state → invalidate (pushes received while
 *   backgrounded don't fire the received-listener).
 *
 * Mounted once inside the authenticated app layout so it can read the
 * Kilo Chat current-user context while still covering dashboard and chat
 * screens.
 */
export function useUnreadCountsInvalidation() {
  const queryClient = useQueryClient();
  const userId = useCurrentUserId();

  useEffect(() => {
    if (userId === null) {
      return undefined;
    }

    const invalidate = () => {
      advanceBadgeFreshnessEpoch();
      void queryClient.invalidateQueries({
        queryKey: ['badges', userId],
      });
    };

    const received = Notifications.addNotificationReceivedListener(notification => {
      const data = parseNotificationData(notification.request.content.data);
      if (data?.type === 'chat.message') {
        invalidate();
      }
    });

    const appStateSubscription = AppState.addEventListener('change', state => {
      if (state === 'active') {
        invalidate();
      }
    });

    return () => {
      received.remove();
      appStateSubscription.remove();
    };
  }, [queryClient, userId]);
}
