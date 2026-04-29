import { useQueryClient } from '@tanstack/react-query';
import * as Notifications from 'expo-notifications';
import { useEffect } from 'react';
import { AppState } from 'react-native';

import { parseNotificationData } from '@/lib/notifications';
import { useTRPC } from '@/lib/trpc';

/**
 * Keeps the `user.getUnreadCounts` cache in sync with real-time notification
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
  const trpc = useTRPC();

  useEffect(() => {
    // `trpc` is stable (memoized inside TRPCProvider) but `queryKey()` returns
    // a fresh array on each call, so we resolve it inside each invalidation.
    const invalidate = () => {
      void queryClient.invalidateQueries({
        queryKey: trpc.user.getUnreadCounts.queryKey(),
      });
    };

    const received = Notifications.addNotificationReceivedListener(notification => {
      const data = parseNotificationData(notification.request.content.data);
      if (data?.type === 'chat') {
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
  }, [queryClient, trpc]);
}
