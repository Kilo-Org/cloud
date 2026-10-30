import {
  InvalidSecurityScopeRoute,
  useSecurityAgentScope,
} from '@/components/security-agent/security-agent-scope-route';
import { ScopeEntryScreen } from '@/components/security-agent/scope-entry-screen';

export default function SecurityAgentScopeRoute() {
  const scope = useSecurityAgentScope();

  if (!scope) {
    return <InvalidSecurityScopeRoute />;
  }

  return <ScopeEntryScreen scope={scope} />;
}
