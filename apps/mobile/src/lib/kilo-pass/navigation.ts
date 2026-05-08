import { type Href } from 'expo-router';

const PROFILE_ROUTE = '/(app)/profile' as Href;

type KiloPassPurchaseCompletionRouter = {
  dismissTo: (href: Href) => void;
};

export function ensureProfileAfterKiloPassPurchase(router: KiloPassPurchaseCompletionRouter) {
  router.dismissTo(PROFILE_ROUTE);
}
