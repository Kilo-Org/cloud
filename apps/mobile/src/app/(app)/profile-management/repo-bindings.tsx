import { useLocalSearchParams } from 'expo-router';

import { RepoBindingsScreen } from '@/components/profiles/repo-bindings-screen';
import { useLeaveStaleProfileScope } from '@/lib/hooks/use-leave-stale-profile-scope';
import { parseParam } from '@/lib/route-params';

export default function AppStackRepoBindingsRoute() {
  const { organizationId: rawOrganizationId } = useLocalSearchParams<{
    organizationId?: string;
  }>();
  const organizationId = parseParam(rawOrganizationId) ?? undefined;
  const staleScope = useLeaveStaleProfileScope(organizationId, 'app');
  if (staleScope) {
    return null;
  }
  return <RepoBindingsScreen organizationId={organizationId} stack="app" />;
}
