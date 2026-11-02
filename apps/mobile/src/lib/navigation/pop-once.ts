import { useNavigation, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef } from 'react';
import { BackHandler } from 'react-native';

import { armLeaveSettle } from '@/lib/navigation/leave-settle';

/**
 * A `router.back()` that dismisses the calling route at most once, and never
 * once that route is already on its way out.
 *
 * A save the screen awaits can resolve after the user left (header Back,
 * Android Back, the iOS swipe), and it can also resolve just before the user's
 * Back is handled. Both screens of that pair must not pop: a single Back closes
 * one screen, never the one beneath it.
 *
 * Two signals say the route is leaving. A hardware Back that reaches this
 * route records it before the navigator commits anything, so a save that
 * resolves during that transition no longer dismisses. `isFocused()` stays as
 * the backstop for the header control and the swipe, which no Back listener
 * sees; a route the navigator already removed reports itself unfocused.
 *
 * The other direction likewise: when this route is the one that dismissed, a
 * Back pressed while it animates out would pop the screen beneath. This route's
 * listener answers it while the route is still mounted, and `LeaveSettleMount`
 * covers the rest of the animation, after the navigator removed the route.
 */
export function usePopOnce(): () => void {
  const navigation = useNavigation();
  const router = useRouter();
  const leavingRef = useRef(false);

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (leavingRef.current) {
        return true;
      }
      if (!navigation.isFocused()) {
        return false;
      }
      leavingRef.current = true;
      return false;
    });
    return () => {
      subscription.remove();
    };
  }, [navigation]);

  return useCallback(() => {
    if (leavingRef.current || !navigation.isFocused()) {
      return;
    }
    leavingRef.current = true;
    armLeaveSettle(Date.now());
    router.back();
  }, [navigation, router]);
}