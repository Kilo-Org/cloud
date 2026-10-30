import { useNavigation, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';

import {
  isProfileScopeStale,
  staleProfileScopeExit,
} from '@/components/profiles/profile-scope-model';
import { useStackSafeReplace } from '@/lib/navigation/stack-safe-replace';
import { useRouteFocused } from '@/lib/navigation/route-focus';
import { useOrganization } from '@/lib/organization-context';
import {
  getProfilesPath,
  getProfilesRouteName,
  type ProfileManagementStack,
} from '@/lib/profile-agent-navigation';

/** The navigation object a screen of a Stack sees. */
type StackNavigation = {
  getState: () => { index: number; routes: { name: string }[] };
};

/**
 * Leave a profile route that shows the account the app has switched away from,
 * and report whether it is stale so the caller can keep the previous account's
 * profile off screen while the dismissal runs.
 *
 * The account switch itself changes no navigation state (`setOrganizationId`),
 * so a detail pushed under the previous account stays mounted and keeps reading
 * and writing that organization's profile. This closes it: back to the list it
 * was opened from, back to the screen that opened it, or past a pushed list
 * when it is the only route of its stack (`staleProfileScopeExit`).
 *
 * Focus is part of the decision, not only of the call: the tabs freeze a
 * blurred scene (`freezeOnBlur`), so a switch made from another tab settles
 * here when the Profile tab is shown again, and an unfocused screen never
 * navigates the tab that happens to be on screen.
 */
export function useLeaveStaleProfileScope(
  routeOrganizationId: string | undefined,
  stack: ProfileManagementStack
): boolean {
  const router = useRouter();
  const navigation = useNavigation<StackNavigation>();
  const { replace: pushPastStale } = useStackSafeReplace();
  const routeFocused = useRouteFocused();
  const { organizationId, isLoaded } = useOrganization();
  // The account this screen was opened under. A screen may legitimately carry
  // an organization that is not the selection — an agent session's own
  // organization, or the composer's explicit scope — so only a change of
  // account makes the route stale.
  const [openedUnder, setOpenedUnder] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (openedUnder === undefined && isLoaded) {
      setOpenedUnder(organizationId);
    }
  }, [isLoaded, openedUnder, organizationId]);
  const stale = isProfileScopeStale({
    isLoaded,
    activeOrganizationId: organizationId,
    openedUnderOrganizationId: openedUnder,
    routeOrganizationId,
  });

  useEffect(() => {
    if (!stale || !routeFocused) {
      return;
    }
    const state = navigation.getState();
    const exit = staleProfileScopeExit({
      routes: state.routes,
      currentIndex: state.index,
      profilesRouteName: getProfilesRouteName(stack),
    });
    if (exit === 'profiles-list') {
      router.dismissTo(getProfilesPath(stack));
      return;
    }
    if (exit === 'push-list') {
      pushPastStale(getProfilesPath(stack));
      return;
    }
    router.back();
  }, [navigation, pushPastStale, routeFocused, router, stack, stale]);

  return stale;
}
