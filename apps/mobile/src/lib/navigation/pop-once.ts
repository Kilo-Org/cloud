import { useNavigation, useRouter } from 'expo-router';
import { useCallback, useEffect } from 'react';
import { BackHandler } from 'react-native';

import { armLeaveSettle, backInFlight, insideLeaveSettle, noteAcceptedBack } from './leave-settle';

/**
 * A `router.back()` that dismisses the calling route at most once, and never
 * once that route is already on its way out.
 *
 * A save the screen awaits can resolve after the user left (header Back,
 * Android Back, the iOS swipe), and it can also resolve just before the user's
 * Back is applied. Both screens of that pair must not pop: a single Back closes
 * one screen, never the one beneath it.
 *
 * Two bounded windows say the route is leaving, so neither can outlive the
 * moment it describes. A hardware Back this route accepts opens one before the
 * navigator commits anything, so a save resolving during that transition no
 * longer dismisses. `isFocused()` stays as the backstop for the header control
 * and the swipe, which no Back listener sees; a route the navigator already
 * removed reports itself unfocused.
 *
 * The other direction lives in `LeaveSettleMount`: once this route is removed,
 * a Back still inside the exit animation is spent by the app shell instead, and
 * this hook's own dismissal opens that window.
 */
export function usePopOnce(): () => void {
  const navigation = useNavigation();
  const router = useRouter();

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (navigation.isFocused()) {
        noteAcceptedBack(Date.now());
      }
      // The press takes its usual path: the navigator pops this screen, and any
      // dismissal that resolves meanwhile is suppressed by the mark above.
      return false;
    });
    return () => {
      subscription.remove();
    };
  }, [navigation]);

  return useCallback(() => {
    const now = Date.now();
    if (!navigation.isFocused() || insideLeaveSettle(now) || backInFlight(now)) {
      return;
    }
    armLeaveSettle(now);
    router.back();
  }, [navigation, router]);
}
