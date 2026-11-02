import { useNavigation, useRouter } from 'expo-router';
import { useCallback, useEffect, useId } from 'react';
import { BackHandler } from 'react-native';

import {
  armLeaveSettle,
  backAcceptedBy,
  clearAcceptedBack,
  insideLeaveSettle,
  noteAcceptedBack,
} from './leave-settle';

/**
 * A `router.back()` that dismisses the calling route at most once, and never
 * once that route is already on its way out.
 *
 * A save the screen awaits can resolve after the user left (header Back,
 * Android Back, the iOS swipe), and it can also resolve after the user's Back
 * but before the navigator applied it. Both screens of that pair must not pop:
 * a single Back closes one screen, never the one beneath it.
 *
 * The two marks that say so end differently on purpose. A Back this route
 * accepted belongs to this route and is forgotten when the route blurs — the
 * navigator applying it — or when it leaves at all, so a slow device only
 * lengthens the interval and a cancelled leave clears it explicitly. A
 * dismissal keeps a bounded window because the route it describes is already
 * gone; `LEAVE_SETTLE_MS` carries the exit-animation measurement that bounds it.
 *
 * The other direction lives in `LeaveSettleMount`: once this route is removed,
 * a Back still inside that window is spent by the app shell instead, and this
 * hook's own dismissal opens it.
 */
export function usePopOnce(): () => void {
  const navigation = useNavigation();
  const router = useRouter();
  const routeId = useId();

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      // Every press this route can see is recorded. Whether it is applied here
      // or spent by the app shell is decided by the shell's own single clock
      // read, and the shell clears the mark it spends, so the two listeners can
      // never disagree about the same press at the window's edge.
      if (navigation.isFocused()) {
        noteAcceptedBack(routeId, Date.now());
      }
      // The press takes its usual path: the navigator pops this screen, and a
      // dismissal that resolves meanwhile is suppressed by the mark above.
      return false;
    });
    return () => {
      subscription.remove();
    };
  }, [navigation, routeId]);

  // The route blurring is the navigator having applied the Back, however long
  // that took. A leave the reader cancels never blurs, so the guard that
  // cancelled it clears the mark instead. Unmounting ends it too: this route is
  // gone, so nothing of its Back can be pending any more.
  useEffect(() => {
    const forget = () => {
      clearAcceptedBack(routeId);
    };
    const unsubscribe = navigation.addListener('blur', forget);
    return () => {
      unsubscribe();
      forget();
    };
  }, [navigation, routeId]);

  return useCallback(() => {
    if (!navigation.isFocused() || insideLeaveSettle(Date.now()) || backAcceptedBy(routeId)) {
      return;
    }
    armLeaveSettle(Date.now());
    router.back();
  }, [navigation, routeId, router]);
}
