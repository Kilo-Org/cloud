import { type Href } from 'expo-router';

/**
 * Home tab root. The fixed landing target when the tour is dismissed with no
 * screen beneath it. The group href (no trailing `/index`) is the route
 * expo-router matches — the `/index` suffix resolves to the not-found screen.
 */
export const HOME_TAB_ROOT = '/(app)/(tabs)/(0_home)' as Href;

type TourDismissRouter = {
  canGoBack: () => boolean;
  back: () => void;
  replace: (href: Href) => void;
};

/**
 * Dismiss the tour, landing somewhere sensible.
 *
 * Skip, Done and Android hardware Back are one decision: record it, then
 * leave. `router.back()` dispatches GO_BACK, and expo-router forwards it to
 * the focused navigator; when the tour is the app's first route (opened by a
 * deep link or a restored pending navigation, so no screen sits beneath it)
 * nothing can handle that action — the modal stays up, the decision is
 * recorded invisibly, and React Native's development-only LogBox banner
 * ("The action 'GO_BACK' was not handled by any navigator") covers the
 * Skip/Done action bar. Falling back to the home tab makes Back, Skip and
 * Done dismiss in every state, exactly like the finding-detail back target.
 */
export function dismissTour(router: TourDismissRouter): void {
  if (router.canGoBack()) {
    router.back();
    return;
  }
  router.replace(HOME_TAB_ROOT);
}
