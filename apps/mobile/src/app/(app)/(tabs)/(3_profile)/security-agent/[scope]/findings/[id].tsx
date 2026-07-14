import { type Href, useLocalSearchParams } from 'expo-router';

import { InvalidRouteState } from '@/components/invalid-route-state';
import { FindingDetailScreen } from '@/components/security-agent/finding-detail-screen';
import { parseParam } from '@/lib/route-params';

export default function SecurityAgentFindingDetailRoute() {
  const { scope, id: rawId } = useLocalSearchParams<{ scope: string; id: string }>();
  const findingId = parseParam(rawId);

  if (!findingId) {
    return (
      <InvalidRouteState backTo={`/(app)/(tabs)/(3_profile)/security-agent/${scope}` as Href} />
    );
  }

  return <FindingDetailScreen scope={scope} findingId={findingId} />;
}
