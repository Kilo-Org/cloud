import { useQuery } from '@tanstack/react-query';
import { type Href, useRouter } from 'expo-router';
import { useEffect } from 'react';

import { classifyPermission, type PermissionState } from '@/lib/code-reviewer-status';
import { PERSONAL_SCOPE, type ReviewerPlatform } from '@/lib/code-reviewer-config';
import { useTRPC } from '@/lib/trpc';

function isPersonal(scope: string) {
  return scope === PERSONAL_SCOPE;
}

export function useReviewerPermission(scope: string): PermissionState {
  const trpc = useTRPC();
  const query = useQuery({
    ...trpc.organizations.list.queryOptions(),
    enabled: !isPersonal(scope),
  });
  const role = query.data?.find(org => org.organizationId === scope)?.role;
  return classifyPermission({
    isPersonal: isPersonal(scope),
    isLoading: query.isLoading,
    isError: query.isError,
    isFetching: query.isFetching,
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
  const router = useRouter();
  const permission = useReviewerPermission(scope);
  const readOnly = permission.status === 'ready' && !permission.canEdit;

  useEffect(() => {
    if (readOnly) {
      router.replace(`/(app)/(tabs)/(3_profile)/code-reviewer/${scope}/${platform}` as Href);
    }
  }, [readOnly, router, scope, platform]);
}
