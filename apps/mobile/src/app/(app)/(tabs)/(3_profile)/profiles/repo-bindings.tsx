import { useLocalSearchParams } from 'expo-router';

import { RepoBindingsScreen } from '@/components/profiles/repo-bindings-screen';
import { useLeaveStaleProfileScope } from '@/lib/hooks/use-leave-stale-profile-scope';
import { useRepairProfileRouteStack } from '@/lib/hooks/use-repair-profile-route-stack';
import { getRepoBindingsPath } from '@/lib/profile-agent-navigation';
import {
  EXTERNAL_OPENERS,
  LIST_CHILD_PARENTS,
  profileExternalOpener,
} from '@/lib/profile-route-stack';
import { parseParam } from '@/lib/route-params';

export default function RepoBindingsRoute() {
  const { organizationId: rawOrganizationId, openedFrom: rawOpenedFrom } = useLocalSearchParams<{
    organizationId?: string;
    openedFrom?: string;
  }>();
  const organizationId = parseParam(rawOrganizationId) ?? undefined;
  const openedFrom = profileExternalOpener({
    openedFrom: parseParam(rawOpenedFrom, EXTERNAL_OPENERS) ?? undefined,
  });
  const staleScope = useLeaveStaleProfileScope(organizationId, 'profileTab');
  // A link that arrives without the profiles list beneath it rebuilds it, so
  // Back returns to the list instead of closing the tab's stack.
  useRepairProfileRouteStack({
    organizationId,
    parents: LIST_CHILD_PARENTS,
    self: getRepoBindingsPath({ organizationId }),
    stack: 'profileTab',
  });
  if (staleScope) {
    return null;
  }
  return (
    <RepoBindingsScreen
      organizationId={organizationId}
      stack="profileTab"
      openedFrom={openedFrom ?? undefined}
    />
  );
}
