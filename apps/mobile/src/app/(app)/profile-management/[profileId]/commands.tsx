import { useLocalSearchParams } from 'expo-router';

import { InvalidRouteState } from '@/components/invalid-route-state';
import { ProfileCommandsScreen } from '@/components/profiles/profile-commands-screen';
import { RootStackProfileScreen } from '@/components/profiles/root-stack-profile-screen';
import { getProfilesPath } from '@/lib/profile-agent-navigation';
import { parseParam } from '@/lib/route-params';

export default function AppStackProfileCommandsRoute() {
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
      <ProfileCommandsScreen
        profileId={profileId}
        organizationId={parseParam(rawOrganizationId) ?? undefined}
      />
    </RootStackProfileScreen>
  );
}
