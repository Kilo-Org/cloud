import { useLocalSearchParams } from 'expo-router';

import { InvalidRouteState } from '@/components/invalid-route-state';
import { ProfileKiloCommandsScreen } from '@/components/profiles/profile-kilo-commands-screen';
import { useLeaveStaleProfileScope } from '@/lib/hooks/use-leave-stale-profile-scope';
import { getProfilesPath } from '@/lib/profile-agent-navigation';
import { parseParam } from '@/lib/route-params';

export default function ProfileSlashCommandsRoute() {
  const { profileId: rawProfileId, organizationId: rawOrganizationId } = useLocalSearchParams<{
    profileId: string;
    organizationId?: string;
  }>();
  const profileId = parseParam(rawProfileId);
  const organizationId = parseParam(rawOrganizationId) ?? undefined;
  const staleScope = useLeaveStaleProfileScope(organizationId, 'profileTab');
  if (!profileId) {
    return <InvalidRouteState backTo={getProfilesPath()} />;
  }
  if (staleScope) {
    return null;
  }
  return <ProfileKiloCommandsScreen profileId={profileId} organizationId={organizationId} />;
}
