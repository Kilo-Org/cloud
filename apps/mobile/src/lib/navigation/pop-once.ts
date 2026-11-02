import { useNavigation, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef } from 'react';
import { BackHandler } from 'react-native';

import { armLeaveSettle, BACK_COMMIT_MS, insideLeaveSettle, insideWindow } from './leave-settle';

/**
 * A `router.back()` that dismisses the calling route at most once, and never
 * once that route is already on its way out.
 *
 * A save the screen awaits can resolve after the user left (header Back,
 * Android Back, the iOS swipe), and it can also resolve before the navigator
 * has finished applying the user's own Back. Both screens of that pair must not
 * pop: a single Back closes one screen, never the one beneath it.
 *
 * Two marks say the route is leaving, and both expire instead of latching. A
 * Back this route accepts marks the route for the navigator's commit turnaround
 * (`BACK_COMMIT_MS`), which is the only span in which the save could dispatch a
 * competing pop. `isFocused()` stays as the backstop for the header control and
 * the swipe, which no Back listener sees; a route the navigator already removed
 * reports itself unfocused.
 *
 * The other direction lives in `LeaveSettleMount`: once this route is removed,
 * a Back still inside the exit animation is spent by the app shell instead, and
 * this hook's own dismissal opens that window.
 */
export function usePopOnce(): () => void {
  const navigation = useNavigation();
  const router = useRouter();
  const acceptedBackAtRef = useRef(0);

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (navigation.isFocused()) {
        acceptedBackAtRef.current = Date.now();
      }
      // The press takes its usual path: the navigator pops this screen, and a
      // dismissal that resolves meanwhile is suppressed by the mark above.
      return false;
    });
    return () => {
      subscription.remove();
    };
  }, [navigation]);

  return useCallback(() => {
    const now = Date.now();
    if (
      !navigation.isFocused() ||
      insideLeaveSettle(now) ||
      insideWindow(acceptedBackAtRef.current, now, BACK_COMMIT_MS)
    ) {
      return;
    }
    armLeaveSettle(now);
    router.back();
  }, [navigation, router]);
}
