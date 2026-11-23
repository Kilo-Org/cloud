import { type SecurityFindingRouteParams } from '@kilocode/app-shared/security-agent';
import { useLocalSearchParams } from 'expo-router';

import { FindingListScreen } from '@/components/security-agent/finding-list-screen';
import {
  InvalidSecurityScopeRoute,
  useSecurityAgentScope,
} from '@/components/security-agent/security-agent-scope-route';
import { useRetireCoveredSource } from '@/lib/navigation/retire-covered-source';
import { SCOPE_DASHBOARD_ROUTE_NAME } from '@/lib/security-agent-route-stack';

// This screen's sibling detail route, named by its path below the `[scope]`
// Stack that declares `index`, `dismiss/[id]` and `filter` in its `_layout.tsx`.
const FINDING_DETAIL_ROUTE_NAME = 'findings/[id]';

export default function SecurityAgentFindingListRoute() {
  // Back on a detail with no local history swaps in this list through the
  // stack-safe replace, whose source-side retire never runs while the detail is
  // covered. This list owns the removal instead: whichever frame the group's
  // scene repair left — the dashboard (`index`) beneath a detail that was
  // already repaired, or spliced directly beneath this list when the detail
  // held the stack alone — the nearest finding detail below this screen next to
  // the dashboard is that hand-off's source, so removing it makes one Back from
  // here step to the dashboard instead of landing back on the finding.
  useRetireCoveredSource(FINDING_DETAIL_ROUTE_NAME, SCOPE_DASHBOARD_ROUTE_NAME);
  const scope = useSecurityAgentScope();
  const { scope: _scope, ...routeParams } = useLocalSearchParams<
    { scope: string } & SecurityFindingRouteParams
  >();

  if (!scope) {
    return <InvalidSecurityScopeRoute />;
  }

  return <FindingListScreen scope={scope} routeParams={routeParams} />;
}
