import { useLocalSearchParams } from 'expo-router';

import { InvalidRouteState } from '@/components/invalid-route-state';
import { ProfileAgentsScreen } from '@/components/profiles/profile-agents-screen';
import { RootStackProfileScreen } from '@/components/profiles/root-stack-profile-screen';
import { getProfilesPath } from '@/lib/profile-agent-navigation';
import { parseParam } from '@/lib/route-params';

export default function AppStackProfileAgentsRoute() {
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
      <ProfileAgentsScreen
        profileId={profileId}
        organizationId={parseParam(rawOrganizationId) ?? undefined}
      />
    </RootStackProfileScreen>
  );
}
