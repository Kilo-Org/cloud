import { type Href, useLocalSearchParams } from 'expo-router';

import { InvalidRouteState } from '@/components/invalid-route-state';
import { MemberLimitSheet } from '@/components/organization/member-limit-sheet';
import { useLeaveStaleOrganizationScope } from '@/lib/hooks/use-leave-stale-organization-scope';
import { parseParam } from '@/lib/route-params';

export default function MemberLimitRoute() {
  const { memberId: rawMemberId } = useLocalSearchParams<{ memberId: string }>();
  const memberId = parseParam(rawMemberId);
  // The member and their limit belong to the account the sheet was opened
  // under; a switch elsewhere closes it.
  const stale = useLeaveStaleOrganizationScope();

  if (!memberId) {
    return <InvalidRouteState backTo={'/(app)/(tabs)/(3_profile)/organization' as Href} />;
  }

  if (stale) {
    return null;
  }

  return <MemberLimitSheet memberId={memberId} />;
}
