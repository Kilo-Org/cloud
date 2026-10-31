import { useLocalSearchParams } from 'expo-router';

import { InvalidRouteState } from '@/components/invalid-route-state';
import { ProfileKiloCommandsScreen } from '@/components/profiles/profile-kilo-commands-screen';
import { useLeaveStaleProfileScope } from '@/lib/hooks/use-leave-stale-profile-scope';
import { useRepairProfileRouteStack } from '@/lib/hooks/use-repair-profile-route-stack';
import { getProfileSlashCommandsPath, getProfilesPath } from '@/lib/profile-agent-navigation';
import { SECTION_PARENTS } from '@/lib/profile-route-stack';
import { parseParam } from '@/lib/route-params';

export default function AppStackProfileSlashCommandsRoute() {
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
        : getProfileSlashCommandsPath(profileId, organizationId, 'app'),
    stack: 'app',
  });
  if (profileId === null) {
    return <InvalidRouteState backTo={getProfilesPath('app')} />;
  }
  if (staleScope) {
    return null;
  }
  return <ProfileKiloCommandsScreen profileId={profileId} organizationId={organizationId} />;
}