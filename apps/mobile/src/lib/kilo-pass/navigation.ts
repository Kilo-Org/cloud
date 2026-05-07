import { type Href } from 'expo-router';

type KiloPassCompletionRouter = {
  back: () => void;
  canGoBack: () => boolean;
  replace: (href: Href) => void;
};

const KILO_PASS_COMPLETION_FALLBACK_ROUTE = '/(app)/profile' as Href;

export function dismissKiloPassAfterPurchase(router: KiloPassCompletionRouter) {
  if (router.canGoBack()) {
    router.back();
    return;
  }

  router.replace(KILO_PASS_COMPLETION_FALLBACK_ROUTE);
}
