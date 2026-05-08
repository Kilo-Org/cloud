import { type Href } from 'expo-router';

const HOME_ROUTE = '/(app)/(tabs)/(0_home)' as Href;
const PROFILE_ROUTE = '/(app)/profile' as Href;

type KiloPassPurchaseCompletionRouter = {
  dismissAll: () => void;
  navigate: (href: Href) => void;
  replace: (href: Href) => void;
};

export function resetToProfileAfterKiloPassPurchase(router: KiloPassPurchaseCompletionRouter) {
  router.dismissAll();
  router.replace(HOME_ROUTE);
  router.navigate(PROFILE_ROUTE);
}
