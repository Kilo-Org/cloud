import { type SecurityFindingRouteParams } from '@kilocode/app-shared/security-agent';
import { useLocalSearchParams } from 'expo-router';

import { FindingListScreen } from '@/components/security-agent/finding-list-screen';

export default function SecurityAgentFindingListRoute() {
  const { scope, ...routeParams } = useLocalSearchParams<
    { scope: string } & SecurityFindingRouteParams
  >();
  return <FindingListScreen scope={scope} routeParams={routeParams} />;
}
