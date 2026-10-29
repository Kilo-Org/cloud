import { useLocalSearchParams } from 'expo-router';

import { PROFILE_OWNER_CHOICES } from '@/components/profiles/profile-owner-model';
import { NewProfileScreen } from '@/components/profiles/new-profile-screen';
import { NEW_PROFILE_RETURNS, type ProfileManagementStack } from '@/lib/profile-agent-navigation';
import { parseParam } from '@/lib/route-params';

/**
 * The create screen in the root Stack. A picker that opened it asks for the
 * owner its list shows (`owner`) and for the form to come back to it
 * (`returnTo=back`); a plain entry gets neither.
 */
export default function AppStackNewProfileRoute() {
  const stack: ProfileManagementStack = 'app';
  const { owner: rawOwner, returnTo: rawReturnTo } = useLocalSearchParams<{
    owner?: string;
    returnTo?: string;
  }>();
  return (
    <NewProfileScreen
      stack={stack}
      initialOwner={parseParam(rawOwner, PROFILE_OWNER_CHOICES) ?? undefined}
      returnToCaller={parseParam(rawReturnTo, NEW_PROFILE_RETURNS) !== null}
    />
  );
}
