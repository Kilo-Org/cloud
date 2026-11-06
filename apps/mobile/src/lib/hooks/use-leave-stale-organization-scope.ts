import { useNavigation, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';

import {
  isOrganizationScopeStale,
  staleOrganizationScopeExit,
} from '@/components/organization/organization-scope-model';
import { useRouteFocused } from '@/lib/navigation/route-focus';
import { useStackSafeReplace } from '@/lib/navigation/stack-safe-replace';
import { useOrganization } from '@/lib/organization-context';
import { ORGANIZATION_HUB_PATH, ORGANIZATION_HUB_ROUTE_NAME } from '@/lib/organization-navigation';

/** The navigation object a screen of a Stack sees. */
type StackNavigation = {
  getState: () => { index: number; routes: { name: string }[] };
};

/**
 * Leave an organization route that shows the account the app has switched away
 * from, and report whether it is stale so the caller can keep the previous
 * account's screen off screen while the dismissal runs.
 *
 * The account switch itself changes no navigation state (`setOrganizationId`),
 * so a screen opened under the previous account stays mounted and re-scopes to
 * the next one, where it may be refused (a plain member has no invoices). This
 * closes it: back to the hub of the current account, back to the screen that
 * opened it, or past a pushed hub when it is the only route of its stack
 * (`staleOrganizationScopeExit`).
 *
 * Focus is part of the decision, not only of the call: a switch made from
 * another screen settles here when this screen regains focus, and an unfocused
 * screen never navigates the tab that happens to be on screen.
 */
export function useLeaveStaleOrganizationScope({
  namesOwnOrganization = false,
}: Readonly<{ namesOwnOrganization?: boolean }> = {}): boolean {
  const router = useRouter();
  const navigation = useNavigation<StackNavigation>();
  const { replace: pushPastStale } = useStackSafeReplace();
  const routeFocused = useRouteFocused();
  const { organizationId, isLoaded } = useOrganization();
  // The account this screen was opened under. Resolved once, so the switch that
  // makes it stale is the one that happened after it appeared.
  const [openedUnder, setOpenedUnder] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (openedUnder === undefined && isLoaded) {
      setOpenedUnder(organizationId);
    }
  }, [isLoaded, openedUnder, organizationId]);
  const stale = isOrganizationScopeStale({
    isLoaded,
    activeOrganizationId: organizationId,
    openedUnderOrganizationId: openedUnder,
    namesOwnOrganization,
  });

  useEffect(() => {
    if (!stale || !routeFocused) {
      return;
    }
    const state = navigation.getState();
    const exit = staleOrganizationScopeExit({
      routes: state.routes,
      currentIndex: state.index,
      hubRouteName: ORGANIZATION_HUB_ROUTE_NAME,
    });
    if (exit === 'hub') {
      router.dismissTo(ORGANIZATION_HUB_PATH);
      return;
    }
    if (exit === 'push-hub') {
      pushPastStale(ORGANIZATION_HUB_PATH);
      return;
    }
    router.back();
  }, [navigation, pushPastStale, routeFocused, router, stale]);

  return stale;
}
