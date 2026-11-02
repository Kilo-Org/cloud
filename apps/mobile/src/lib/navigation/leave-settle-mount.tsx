import { useEffect } from 'react';
import { BackHandler } from 'react-native';

import { insideLeaveSettle } from '@/lib/navigation/leave-settle';

/**
 * Spends a Back that arrives while a screen that dismissed itself is still
 * animating out.
 *
 * The dismissing screen is unmounted before Android delivers that Back to
 * JavaScript, so its own listener is gone and the press would pop the screen
 * beneath instead — one Back closing two screens. This listener is mounted for
 * the whole app session, so it outlives the route whose leave opened the
 * window (see `leave-settle.ts`), and it answers before the navigator's own
 * handler because React Native asks listeners newest first.
 *
 * Nothing else is affected: outside the window this returns `false` and the
 * press takes its usual path.
 */
export function LeaveSettleMount(): null {
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () =>
      insideLeaveSettle(Date.now())
    );
    return () => {
      subscription.remove();
    };
  }, []);

  return null;
}
