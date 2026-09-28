import { useLocalSearchParams } from 'expo-router';

import { InvalidRouteState } from '@/components/invalid-route-state';
import { ProfileSkillsScreen } from '@/components/profiles/profile-skills-screen';
import { getProfilesPath } from '@/lib/profile-agent-navigation';
import { parseParam } from '@/lib/route-params';

export default function ProfileSkillsRoute() {
  const { profileId: rawProfileId, organizationId: rawOrganizationId } = useLocalSearchParams<{
    profileId: string;
    organizationId?: string;
  }>();
  const profileId = parseParam(rawProfileId);
  if (!profileId) {
    return <InvalidRouteState backTo={getProfilesPath()} />;
  }
  return (
    <ProfileSkillsScreen
      profileId={profileId}
      organizationId={parseParam(rawOrganizationId) ?? undefined}
    />
  );
}
