import {
  InvalidSecurityScopeRoute,
  useSecurityAgentScope,
} from '@/components/security-agent/security-agent-scope-route';
import { SlaSettingsScreen } from '@/components/security-agent/sla-settings-screen';

export default function SecurityAgentSlaSettingsRoute() {
  const scope = useSecurityAgentScope();

  if (!scope) {
    return <InvalidSecurityScopeRoute />;
  }

  return <SlaSettingsScreen scope={scope} />;
}
