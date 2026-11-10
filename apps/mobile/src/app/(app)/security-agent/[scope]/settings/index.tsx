import {
  InvalidSecurityScopeRoute,
  useSecurityAgentScope,
} from '@/components/security-agent/security-agent-scope-route';
import { SettingsOverviewScreen } from '@/components/security-agent/settings-overview-screen';

export default function SecurityAgentSettingsRoute() {
  const scope = useSecurityAgentScope();

  if (!scope) {
    return <InvalidSecurityScopeRoute />;
  }

  return <SettingsOverviewScreen scope={scope} presentation="route" />;
}
