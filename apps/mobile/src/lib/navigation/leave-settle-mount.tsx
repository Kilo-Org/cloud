import { useEffect } from 'react';
import { BackHandler } from 'react-native';

import { clearAcceptedBack, insideLeaveSettle } from '@/lib/navigation/leave-settle';

/**
 * Spends a Back that arrives while a screen that dismissed itself is still
 * animating out.
 *
 * The dismissing screen is unmounted before Android delivers that Back to
 * JavaScript, so its own listener is gone and the press would pop the screen
 * beneath instead — one Back closing two screens. This listener is mounted for
 * the whole app session, so it outlives the route whose leave opened the
 * window (see `leave-settle.ts`).
 *
 * React Native asks the newest listener first, so a screen that is still mounted
 * has already recorded this press as one it accepted. Because that screen is not
 * the one leaving, the mark is dropped here for the press spent instead: the
 * same single clock read decides both, so the two listeners cannot disagree
 * about a press at the window's edge.
 *
 * Nothing else is affected: outside the window this returns `false` and the
 * press takes its usual path.
 */
export function LeaveSettleMount(): null {
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!insideLeaveSettle(Date.now())) {
        return false;
      }
      clearAcceptedBack();
      return true;
    });
    return () => {
      subscription.remove();
    };
  }, []);

  return null;
}
