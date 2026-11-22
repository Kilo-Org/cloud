import { useRouter } from 'expo-router';
import { useEffect } from 'react';
import { BackHandler } from 'react-native';

import { InvalidRouteState } from '@/components/invalid-route-state';
import { useStackSafeReplace } from '@/lib/navigation/stack-safe-replace';

/**
 * Terminal screen for a URL no route matches.
 *
 * Both exits are owned here so the in-app Back (`InvalidRouteState`) and the
 * Android hardware/gesture Back agree: return to the previous in-app screen
 * when there is one, otherwise replace this route with the app root. Without
 * the hardware-back listener a cold deep link to a dead path leaves this route
 * as the only screen, and Android's back finishes the Activity — dropping the
 * user out of the app into whatever was last in front of it.
 */
export default function NotFound() {
  const router = useRouter();
  // The hand-off swaps this dead route for the app root, so it goes through the
  // push-then-retire hook: a literal `router.replace` swaps both in one
  // native-stack commit and crashes Android Fabric.
  const { replace } = useStackSafeReplace();

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (router.canGoBack()) {
        // Let the navigator pop to the screen beneath.
        return false;
      }
      replace('/');
      return true;
    });
    return () => {
      subscription.remove();
    };
  }, [replace, router]);

  return <InvalidRouteState backTo="/" />;
}
