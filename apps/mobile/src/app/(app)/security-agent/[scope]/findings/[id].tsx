import { type Href, useLocalSearchParams } from 'expo-router';

import { InvalidRouteState } from '@/components/invalid-route-state';
import { FindingDetailScreen } from '@/components/security-agent/finding-detail-screen';
import {
  InvalidSecurityScopeRoute,
  useSecurityAgentScope,
} from '@/components/security-agent/security-agent-scope-route';
import { parseParam } from '@/lib/route-params';

export default function SecurityAgentFindingDetailRoute() {
  const scope = useSecurityAgentScope();
  const { id: rawId } = useLocalSearchParams<{ scope: string; id: string }>();
  const findingId = parseParam(rawId);

  if (!scope) {
    return <InvalidSecurityScopeRoute />;
  }
  if (!findingId) {
    return <InvalidRouteState backTo={`/(app)/security-agent/${scope}` as Href} />;
  }

  return <FindingDetailScreen scope={scope} findingId={findingId} />;
}
