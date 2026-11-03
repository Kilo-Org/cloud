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
import { useRootNavigationReady } from '@/lib/navigation-ready';

/**
 * Invisible mount: when a pending share navigation exists and the gate route
 * is absent from the navigation state, take it and route to the destination.
 * - Target not focused → router.push(href)
 * - Target already focused → router.setParams({ shareId, organizationId }) only
 * Never cross-presentation replace; back stack stays intact.
 *
 * Both `push` and `setParams` reach the readiness assert (queued ROUTER_LINK
 * drains through getNavigateAction; setParams asserts directly), so both wait
 * for the container's ready bit — the same `useRootNavigationReady` gate the
 * root layout uses. A taken request is consumed by the effect once the gate
 * opens; nothing re-fires it.
 */
export function SharePayloadNavigator(): null {
  const router = useRouter();
  const pathname = usePathname();
  const rootState = useRootNavigationState();
  const navigationReady = useRootNavigationReady();
  const pathnameRef = useRef(pathname);
  pathnameRef.current = pathname;

  useEffect(() => {
    if (!navigationReady) {
      return;
    }
    if (navigationContainsShareGate(rootState)) {
      return;
    }

    const pending = takePendingShareNavigation();
    if (!pending) {
      return;
    }

    deliver(pending, router, pathnameRef.current);
  }, [navigationReady, rootState, router]);

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
