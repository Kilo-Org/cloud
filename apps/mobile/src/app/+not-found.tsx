import { useRouter } from 'expo-router';
import { useEffect } from 'react';
import { BackHandler } from 'react-native';

import { InvalidRouteState } from '@/components/invalid-route-state';

/**
 * Terminal screen for a URL no route matches.
 *
 * Both exits are owned here so the in-app Back (`InvalidRouteState`) and the
 * Android hardware/gesture Back agree: return to the previous in-app screen
 * when there is one, otherwise replace this route with the app root. Without
 * the hardware-back listener a cold deep link to a dead path leaves this route
 * as the only screen, and Android's back finishes the Activity — dropping the
 * user out of the app into whatever was last in front of it.
 *
 * This route renders directly under the root `Slot`, which is a plain router
 * navigator: it emits no transition event, so a push-then-retire could never
 * remove this route and Back from the app root would return to it. The in-app
 * exit replaces at this stack position, which needs no retire; the hardware
 * exit uses the plain router's one-commit replace. Both leave nothing beneath.
 */
export default function NotFound() {
  const router = useRouter();

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (router.canGoBack()) {
        // Let the navigator pop to the screen beneath.
        return false;
      }
      router.replace('/');
      return true;
    });
    return () => {
      subscription.remove();
    };
  }, [router]);

  return <InvalidRouteState backTo="/" />;
}
