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

export default function AppStackProfileOverviewRoute() {
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
    parents: OVERVIEW_PARENTS,
    self:
      profileId === null
        ? getProfilesPath('app')
        : getProfileOverviewPath(profileId, { organizationId, stack: 'app' }),
    stack: 'app',
  });
  // The create hand-off pushes this overview and retires the form beneath it
  // from the form's own listener — which a covered screen never runs. This side
  // owns the retire instead: one reset that removes a `profile-management/new`
  // entry directly beneath this overview, with the list beneath the form.
  useRetireCoveredSource(getNewProfileRouteName('app'), getProfilesRouteName('app'));
  if (profileId === null) {
    return <InvalidRouteState backTo={getProfilesPath('app')} />;
  }
  if (staleScope) {
    return null;
  }
  return (
    <ProfileOverviewScreen profileId={profileId} organizationId={organizationId} stack="app" />
  );
}
