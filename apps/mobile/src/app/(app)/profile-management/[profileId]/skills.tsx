import { useLocalSearchParams } from 'expo-router';

import { InvalidRouteState } from '@/components/invalid-route-state';
import { ProfileSkillsScreen } from '@/components/profiles/profile-skills-screen';
import { useLeaveStaleProfileScope } from '@/lib/hooks/use-leave-stale-profile-scope';
import { useRepairProfileRouteStack } from '@/lib/hooks/use-repair-profile-route-stack';
import { getProfileSkillsPath, getProfilesPath } from '@/lib/profile-agent-navigation';
import { SECTION_PARENTS } from '@/lib/profile-route-stack';
import { parseParam } from '@/lib/route-params';

export default function AppStackProfileSkillsRoute() {
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
        : getProfileSkillsPath(profileId, organizationId, 'app'),
    stack: 'app',
  });
  if (profileId === null) {
    return <InvalidRouteState backTo={getProfilesPath('app')} />;
  }
  if (staleScope) {
    return null;
  }
  return <ProfileSkillsScreen profileId={profileId} organizationId={organizationId} />;
}