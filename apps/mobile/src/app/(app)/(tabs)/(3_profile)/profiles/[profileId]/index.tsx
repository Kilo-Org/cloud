import { useLocalSearchParams } from 'expo-router';

import { InvalidRouteState } from '@/components/invalid-route-state';
import { ProfileOverviewScreen } from '@/components/profiles/profile-overview-screen';
import { useLeaveStaleProfileScope } from '@/lib/hooks/use-leave-stale-profile-scope';
import { useRepairProfileRouteStack } from '@/lib/hooks/use-repair-profile-route-stack';
import { useRetireCoveredSource } from '@/lib/navigation/retire-covered-source';
import {
  getNewProfileRouteName,
  getProfileOverviewPath,
  getProfilesPath,
  getProfilesRouteName,
} from '@/lib/profile-agent-navigation';
import { OVERVIEW_PARENTS } from '@/lib/profile-route-stack';
import { parseParam } from '@/lib/route-params';

export default function ProfileOverviewRoute() {
  const { profileId: rawProfileId, organizationId: rawOrganizationId } = useLocalSearchParams<{
    profileId: string;
    organizationId?: string;
  }>();
  const profileId = parseParam(rawProfileId);
  const organizationId = parseParam(rawOrganizationId) ?? undefined;
  const staleScope = useLeaveStaleProfileScope(organizationId, 'profileTab');
  // A link that arrives without the profiles list beneath it rebuilds it, so
  // Back returns to the list instead of closing the tab's stack.
  useRepairProfileRouteStack({
    profileId,
    organizationId,
    parents: OVERVIEW_PARENTS,
    self:
      profileId === null
        ? getProfilesPath()
        : getProfileOverviewPath(profileId, { organizationId }),
    stack: 'profileTab',
  });
  // The create hand-off pushes this overview and retires the form beneath it
  // from the form's own listener — which a covered screen never runs. This side
  // owns the retire instead: one reset that removes a `profiles/new` entry
  // directly beneath this overview, with the profiles list beneath the form.
  useRetireCoveredSource(getNewProfileRouteName('profileTab'), getProfilesRouteName('profileTab'));
  if (profileId === null) {
    return <InvalidRouteState backTo={getProfilesPath()} />;
  }
  if (staleScope) {
    return null;
  }
  return (
    <ProfileOverviewScreen
      profileId={profileId}
      organizationId={organizationId}
      stack="profileTab"
    />
  );
}
