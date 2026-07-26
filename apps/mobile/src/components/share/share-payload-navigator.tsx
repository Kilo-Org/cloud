import { type Href, usePathname, useRootNavigationState, useRouter } from 'expo-router';
import { useEffect, useRef } from 'react';

import {
  isShareNavigationTargetFocused,
  navigationContainsShareGate,
  type PendingShareNavigation,
  takePendingShareNavigation,
} from '@/lib/share-navigation';

/**
 * Invisible mount: when a pending share navigation exists and the gate route
 * is absent from the navigation state, take it and route to the destination.
 * - Target not focused → router.push(href)
 * - Target already focused → router.setParams({ shareId }) only
 * Never cross-presentation replace; back stack stays intact.
 */
export function SharePayloadNavigator(): null {
  const router = useRouter();
  const pathname = usePathname();
  const rootState = useRootNavigationState();
  const pathnameRef = useRef(pathname);
  pathnameRef.current = pathname;

  useEffect(() => {
    if (navigationContainsShareGate(rootState)) {
      return;
    }

    const pending = takePendingShareNavigation();
    if (!pending) {
      return;
    }

    deliver(pending, router, pathnameRef.current);
  }, [rootState, router]);

  return null;
}

function deliver(
  pending: PendingShareNavigation,
  router: ReturnType<typeof useRouter>,
  pathname: string
): void {
  const focused = isShareNavigationTargetFocused(pending.href, pathname);
  if (focused) {
    router.setParams({ shareId: pending.shareId });
    return;
  }
  router.push(pending.href as Href);
}
