import { useQueryClient } from '@tanstack/react-query';
import * as Notifications from 'expo-notifications';
import { useEffect } from 'react';
import { AppState } from 'react-native';

import { useCurrentUserId } from '@/components/kilo-chat/hooks/use-current-user-id';
import { parseNotificationData } from '@/lib/notifications';
import { unreadCountsInvalidationKeyForNotification } from './unread-counts-invalidation-cache';

/**
 * Keeps the `['badges', userId]` cache in sync with real-time notification
 * traffic so per-instance badges on the dashboard reflect pushes received while
 * the app is open or resumed from background.
 *
 * - Foreground chat push → invalidate (server already incremented the count).
 * - App returns to active state → invalidate (pushes received while
 *   backgrounded don't fire the received-listener).
 *
 * Mounted once inside `RootLayoutNav` so it covers every screen, including
 * when the dashboard is not rendered yet.
 */
export function useUnreadCountsInvalidation() {
  const queryClient = useQueryClient();
  const userId = useCurrentUserId();

  useEffect(() => {
    if (userId === null) {
      return undefined;
    }

    const invalidate = () => {
      void queryClient.invalidateQueries({
        queryKey: ['badges', userId],
      });
    };

    const received = Notifications.addNotificationReceivedListener(notification => {
      const data = parseNotificationData(notification.request.content.data);
      const queryKey = unreadCountsInvalidationKeyForNotification(userId, data);
      if (queryKey === null) {
        return;
      }
      void queryClient.invalidateQueries({ queryKey });
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
