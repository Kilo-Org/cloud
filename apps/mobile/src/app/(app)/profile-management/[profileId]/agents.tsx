import { useLocalSearchParams } from 'expo-router';

import { InvalidRouteState } from '@/components/invalid-route-state';
import { ProfileAgentsScreen } from '@/components/profiles/profile-agents-screen';
import { useLeaveStaleProfileScope } from '@/lib/hooks/use-leave-stale-profile-scope';
import { useRepairProfileRouteStack } from '@/lib/hooks/use-repair-profile-route-stack';
import { getProfileAgentsPath, getProfilesPath } from '@/lib/profile-agent-navigation';
import { SECTION_PARENTS } from '@/lib/profile-route-stack';
import { parseParam } from '@/lib/route-params';

export default function AppStackProfileAgentsRoute() {
  const { profileId: rawProfileId, organizationId: rawOrganizationId } = useLocalSearchParams<{
    profileId: string;
    organizationId?: string;
  }>();
  const profileId = parseParam(rawProfileId);
  const organizationId = parseParam(rawOrganizationId) ?? undefined;
  const staleScope = useLeaveStaleProfileScope(organizationId, 'app');
  // A link that arrives without the profiles list and the overview beneath it
  // rebuilds them, so Back steps through the profile screens instead of leaving
  // the profile tree for whatever happened to be open.
  useRepairProfileRouteStack({
    profileId,
    organizationId,
    parents: SECTION_PARENTS,
    self:
      profileId === null
        ? getProfilesPath('app')
        : getProfileAgentsPath(profileId, organizationId, 'app'),
    stack: 'app',
  });
  if (profileId === null) {
    return <InvalidRouteState backTo={getProfilesPath('app')} />;
  }
  if (staleScope) {
    return null;
  }
  return <ProfileAgentsScreen profileId={profileId} organizationId={organizationId} />;
}