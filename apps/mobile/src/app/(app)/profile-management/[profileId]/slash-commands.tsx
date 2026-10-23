import { useLocalSearchParams } from 'expo-router';

import { InvalidRouteState } from '@/components/invalid-route-state';
import { ProfileKiloCommandsScreen } from '@/components/profiles/profile-kilo-commands-screen';
import { RootStackProfileScreen } from '@/components/profiles/root-stack-profile-screen';
import { getProfilesPath } from '@/lib/profile-agent-navigation';
import { parseParam } from '@/lib/route-params';

export default function AppStackProfileSlashCommandsRoute() {
  const { profileId: rawProfileId, organizationId: rawOrganizationId } = useLocalSearchParams<{
    profileId: string;
    organizationId?: string;
  }>();
  const profileId = parseParam(rawProfileId);
  if (!profileId) {
    return <InvalidRouteState backTo={getProfilesPath('app')} />;
  }
  return (
    <RootStackProfileScreen>
      <ProfileKiloCommandsScreen
        profileId={profileId}
        organizationId={parseParam(rawOrganizationId) ?? undefined}
      />
    </RootStackProfileScreen>
  );
}
