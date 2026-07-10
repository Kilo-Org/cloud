import { useLocalSearchParams } from 'expo-router';

import { MemberLimitSheet } from '@/components/organization/member-limit-sheet';

export default function MemberLimitRoute() {
  const { memberId } = useLocalSearchParams<{ memberId: string }>();
  return <MemberLimitSheet memberId={memberId} />;
}
