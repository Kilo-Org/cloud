import { type Href } from 'expo-router';

type KiloPassCompletionRouter = {
  replace: (href: Href) => void;
};

const KILO_PASS_COMPLETION_FALLBACK_ROUTE = '/(app)/profile' as Href;

export function dismissKiloPassAfterPurchase(router: KiloPassCompletionRouter) {
  router.replace(KILO_PASS_COMPLETION_FALLBACK_ROUTE);
}
