import { useLocalSearchParams } from 'expo-router';

import { InvalidRouteState } from '@/components/invalid-route-state';
import { ProfileSkillsScreen } from '@/components/profiles/profile-skills-screen';
import { RootStackProfileScreen } from '@/components/profiles/root-stack-profile-screen';
import { getProfilesPath } from '@/lib/profile-agent-navigation';
import { parseParam } from '@/lib/route-params';

export default function AppStackProfileSkillsRoute() {
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
      <ProfileSkillsScreen
        profileId={profileId}
        organizationId={parseParam(rawOrganizationId) ?? undefined}
      />
    </RootStackProfileScreen>
  );
}
