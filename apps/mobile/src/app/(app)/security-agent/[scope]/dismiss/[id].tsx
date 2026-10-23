import { type Href, useLocalSearchParams } from 'expo-router';

import { InvalidRouteState } from '@/components/invalid-route-state';
import { DismissFindingScreen } from '@/components/security-agent/dismiss-finding-screen';
import { parseParam } from '@/lib/route-params';

export default function SecurityAgentDismissFindingRoute() {
  const { scope, id: rawId } = useLocalSearchParams<{ scope: string; id: string }>();
  const findingId = parseParam(rawId);

  if (!findingId) {
    return <InvalidRouteState backTo={`/(app)/security-agent/${scope}` as Href} />;
  }

  return <DismissFindingScreen scope={scope} findingId={findingId} />;
}
