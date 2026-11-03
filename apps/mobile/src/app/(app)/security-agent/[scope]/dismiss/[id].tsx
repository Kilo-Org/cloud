import { type Href, useLocalSearchParams } from 'expo-router';

import { InvalidRouteState } from '@/components/invalid-route-state';
import { DismissFindingScreen } from '@/components/security-agent/dismiss-finding-screen';
import {
  InvalidSecurityScopeRoute,
  useSecurityAgentScope,
} from '@/components/security-agent/security-agent-scope-route';
import { parseParam } from '@/lib/route-params';

export default function SecurityAgentDismissFindingRoute() {
  const scope = useSecurityAgentScope();
  const { id: rawId } = useLocalSearchParams<{ scope: string; id: string }>();
  const findingId = parseParam(rawId);

  if (!scope) {
    return <InvalidSecurityScopeRoute />;
  }
  if (!findingId) {
    return <InvalidRouteState backTo={`/(app)/security-agent/${scope}` as Href} />;
  }

  return <DismissFindingScreen scope={scope} findingId={findingId} />;
}
