import { type Href } from 'expo-router';
import { useEffect } from 'react';

import { classifyPermission, type PermissionState } from '@/lib/code-reviewer-status';
import { PERSONAL_SCOPE, type ReviewerPlatform } from '@/lib/code-reviewer-config';
import { useOrganizationsList } from '@/lib/hooks/use-organizations-list';
import { useSettledReplace } from '@/lib/navigation/settled-replace';

function isPersonal(scope: string) {
  return scope === PERSONAL_SCOPE;
}

export function useReviewerPermission(scope: string): PermissionState {
  // These reviewer routes are reachable by URL, so this observer must not start
  // the memberships read before the token resolves, and must settle while
  // offline like the owner does: one hook owns the options of the one cache
  // entry.
  const query = useOrganizationsList({ enabled: !isPersonal(scope) });
  const role = query.data?.find(org => org.organizationId === scope)?.role;
  return classifyPermission({
    isPersonal: isPersonal(scope),
    isLoading: query.isLoading,
    isError: query.isError,
    isFetching: query.isFetching,
    hasData: query.data !== undefined,
    role,
    refetch: () => void query.refetch(),
  });
}

/**
 * Nested code-reviewer settings routes (instructions/repos/focus-areas/
 * style/gate) are directly reachable by URL regardless of whether the
 * overview screen hid the link, so a non-editor landing on one directly
 * gets bounced back to the overview once their role is known. Mirrors
 * `useSecurityAgentSettingsRedirect`'s pattern: dep on a derived primitive
 * (not the raw query/object) and only redirect once resolved to `false`
 * ('loading' or 'error' render the screen as usual — the mutation itself is
 * still server-authorized).
 */
export function useReviewerEditGuard(scope: string, platform: ReviewerPlatform) {
  const settledRouter = useSettledReplace();
  const permission = useReviewerPermission(scope);
  const readOnly = permission.status === 'ready' && !permission.canEdit;

  useEffect(() => {
    if (readOnly) {
      // The bounce can run while the link's own navigation is still
      // transitioning, and a swap inside that commit crashes Android Fabric
      // with `addViewAt … already has a parent`.
      settledRouter.replace(`/(app)/code-reviewer/${scope}/${platform}` as Href);
    }
  }, [readOnly, settledRouter, scope, platform]);
}
