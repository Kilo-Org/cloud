import { useLocalSearchParams } from 'expo-router';

import { InvalidRouteState } from '@/components/invalid-route-state';
import { ProfileVariablesScreen } from '@/components/profiles/profile-variables-screen';
import { useLeaveStaleProfileScope } from '@/lib/hooks/use-leave-stale-profile-scope';
import { useRepairProfileRouteStack } from '@/lib/hooks/use-repair-profile-route-stack';
import { getProfilesPath, getProfileVariablesPath } from '@/lib/profile-agent-navigation';
import { SECTION_PARENTS } from '@/lib/profile-route-stack';
import { parseParam } from '@/lib/route-params';

export default function AppStackProfileVariablesRoute() {
  const { profileId: rawProfileId, organizationId: rawOrganizationId } = useLocalSearchParams<{
    profileId: string;
    organizationId?: string;
  }>();
  const profileId = parseParam(rawProfileId);
  const organizationId = parseParam(rawOrganizationId) ?? undefined;
  const staleScope = useLeaveStaleProfileScope(organizationId, 'app');
  useRepairProfileRouteStack({
    profileId,
    organizationId,
    parents: SECTION_PARENTS,
    self:
      profileId === null
        ? getProfilesPath('app')
        : getProfileVariablesPath(profileId, organizationId, 'app'),
    stack: 'app',
  });
  if (profileId === null) {
    return <InvalidRouteState backTo={getProfilesPath('app')} />;
  }
  if (staleScope) {
    return null;
  }
  return <ProfileVariablesScreen profileId={profileId} organizationId={organizationId} />;
}