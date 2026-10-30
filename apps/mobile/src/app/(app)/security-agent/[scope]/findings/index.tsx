import { type SecurityFindingRouteParams } from '@kilocode/app-shared/security-agent';
import { useLocalSearchParams } from 'expo-router';

import { FindingListScreen } from '@/components/security-agent/finding-list-screen';
import {
  InvalidSecurityScopeRoute,
  useSecurityAgentScope,
} from '@/components/security-agent/security-agent-scope-route';

export default function SecurityAgentFindingListRoute() {
  const scope = useSecurityAgentScope();
  const { scope: _scope, ...routeParams } = useLocalSearchParams<
    { scope: string } & SecurityFindingRouteParams
  >();

  if (!scope) {
    return <InvalidSecurityScopeRoute />;
  }

  return <FindingListScreen scope={scope} routeParams={routeParams} />;
}
