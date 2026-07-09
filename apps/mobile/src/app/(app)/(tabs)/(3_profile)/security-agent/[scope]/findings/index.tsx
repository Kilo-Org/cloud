import { useLocalSearchParams } from 'expo-router';

import { FindingListScreen } from '@/components/security-agent/finding-list-screen';
import { type SecurityFindingRouteParams } from '@/lib/security-agent-filters';

export default function SecurityAgentFindingListRoute() {
  const { scope, ...routeParams } = useLocalSearchParams<
    { scope: string } & SecurityFindingRouteParams
  >();
  return <FindingListScreen scope={scope} routeParams={routeParams} />;
}
