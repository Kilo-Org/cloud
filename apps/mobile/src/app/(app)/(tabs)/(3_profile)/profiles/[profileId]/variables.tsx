import { useLocalSearchParams } from 'expo-router';

import { InvalidRouteState } from '@/components/invalid-route-state';
import { ProfileVariablesScreen } from '@/components/profiles/profile-variables-screen';
import { getProfilesPath } from '@/lib/profile-agent-navigation';
import { parseParam } from '@/lib/route-params';

export default function ProfileVariablesRoute() {
  const { profileId: rawProfileId, organizationId: rawOrganizationId } = useLocalSearchParams<{
    profileId: string;
    organizationId?: string;
  }>();
  const profileId = parseParam(rawProfileId);
  if (!profileId) {
    return <InvalidRouteState backTo={getProfilesPath()} />;
  }
  return (
    <ProfileVariablesScreen
      profileId={profileId}
      organizationId={parseParam(rawOrganizationId) ?? undefined}
    />
  );
}
