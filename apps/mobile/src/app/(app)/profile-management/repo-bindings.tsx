import { useLocalSearchParams } from 'expo-router';

import { RepoBindingsScreen } from '@/components/profiles/repo-bindings-screen';
import { useLeaveStaleProfileScope } from '@/lib/hooks/use-leave-stale-profile-scope';
import { useRepairProfileRouteStack } from '@/lib/hooks/use-repair-profile-route-stack';
import { getRepoBindingsPath } from '@/lib/profile-agent-navigation';
import { LIST_CHILD_PARENTS } from '@/lib/profile-route-stack';
import { parseParam } from '@/lib/route-params';

export default function AppStackRepoBindingsRoute() {
  const { organizationId: rawOrganizationId } = useLocalSearchParams<{
    organizationId?: string;
  }>();
  const organizationId = parseParam(rawOrganizationId) ?? undefined;
  const staleScope = useLeaveStaleProfileScope(organizationId, 'app');
  useRepairProfileRouteStack({
    organizationId,
    parents: LIST_CHILD_PARENTS,
    self: getRepoBindingsPath({ organizationId, stack: 'app' }),
    stack: 'app',
  });
  if (staleScope) {
    return null;
  }
  return <RepoBindingsScreen organizationId={organizationId} stack="app" />;
}
