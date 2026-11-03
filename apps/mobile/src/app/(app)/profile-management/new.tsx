import { useLocalSearchParams } from 'expo-router';

import { PROFILE_OWNER_CHOICES } from '@/components/profiles/profile-owner-model';
import { NewProfileScreen } from '@/components/profiles/new-profile-screen';
import { useRepairProfileRouteStack } from '@/lib/hooks/use-repair-profile-route-stack';
import {
  getNewProfilePath,
  NEW_PROFILE_RETURNS,
  type ProfileManagementStack,
} from '@/lib/profile-agent-navigation';
import { LIST_CHILD_PARENTS } from '@/lib/profile-route-stack';
import { parseParam } from '@/lib/route-params';

/**
 * The create screen in the root Stack. A picker that opened it asks for the
 * owner its list shows (`owner`), for the organization that list reads from
 * (`organizationId`), and for the form to come back to it (`returnTo=back`);
 * a plain entry gets none of them.
 */
export default function AppStackNewProfileRoute() {
  const stack: ProfileManagementStack = 'app';
  const {
    owner: rawOwner,
    returnTo: rawReturnTo,
    organizationId: rawOrganizationId,
  } = useLocalSearchParams<{ owner?: string; returnTo?: string; organizationId?: string }>();
  const owner = parseParam(rawOwner, PROFILE_OWNER_CHOICES) ?? undefined;
  const returnTo = parseParam(rawReturnTo, NEW_PROFILE_RETURNS) ?? undefined;
  const organizationId = parseParam(rawOrganizationId) ?? undefined;
  // A link that arrives without the profiles list beneath it rebuilds it, so
  // Back returns to the list instead of leaving the profile tree.
  useRepairProfileRouteStack({
    organizationId,
    parents: LIST_CHILD_PARENTS,
    self: getNewProfilePath(stack, { owner, returnTo, organizationId }),
    stack,
  });
  return (
    <NewProfileScreen
      stack={stack}
      initialOwner={owner}
      returnToCaller={returnTo !== undefined}
      organizationId={organizationId}
    />
  );
}
