import {
  InvalidSecurityScopeRoute,
  useSecurityAgentScope,
} from '@/components/security-agent/security-agent-scope-route';
import { AutomationSettingsScreen } from '@/components/security-agent/automation-settings-screen';

export default function SecurityAgentAutomationSettingsRoute() {
  const scope = useSecurityAgentScope();

  if (!scope) {
    return <InvalidSecurityScopeRoute />;
  }

  return <AutomationSettingsScreen scope={scope} />;
}
