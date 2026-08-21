import { type Href, useLocalSearchParams } from 'expo-router';

import { InvalidRouteState } from '@/components/invalid-route-state';
import { MemberLimitSheet } from '@/components/organization/member-limit-sheet';
import { parseParam } from '@/lib/route-params';

export default function MemberLimitRoute() {
  const { memberId: rawMemberId } = useLocalSearchParams<{ memberId: string }>();
  const memberId = parseParam(rawMemberId);

  if (!memberId) {
    return <InvalidRouteState backTo={'/(app)/(tabs)/(3_profile)/organization' as Href} />;
  }

  return <MemberLimitSheet memberId={memberId} />;
}
