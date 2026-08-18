import { type Href, usePathname, useRootNavigationState, useRouter } from 'expo-router';
import { useEffect, useRef } from 'react';

import {
  isShareNavigationTargetFocused,
  navigationContainsShareGate,
  parseShareHrefParams,
  type PendingShareNavigation,
  shareDeliveryShareId,
  takePendingShareNavigation,
} from '@/lib/share-navigation';

/**
 * Invisible mount: when a pending share navigation exists and the gate route
 * is absent from the navigation state, take it and route to the destination.
 * - Target not focused → router.push(href)
 * - Target already focused → router.setParams({ shareId, organizationId }) only
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
    // A null shareId is a non-share destination (e.g. Review PR): the target
    // screen is already focused, so there is nothing to push or deliver.
    if (!shareDeliveryShareId(pending)) {
      return;
    }
    // Committed href's org is the destination identity; path-only focus is
    // about the screen, not its params. undefined clears a stale org param.
    router.setParams({
      shareId: pending.shareId,
      organizationId: parseShareHrefParams(pending.href).organizationId,
    });
    return;
  }
  router.push(pending.href as Href);
}
