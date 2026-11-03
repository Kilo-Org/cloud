import {
  InvalidSecurityScopeRoute,
  useSecurityAgentScope,
} from '@/components/security-agent/security-agent-scope-route';
import { RepositorySettingsScreen } from '@/components/security-agent/repository-settings-screen';

export default function SecurityAgentRepositorySettingsRoute() {
  const scope = useSecurityAgentScope();

  if (!scope) {
    return <InvalidSecurityScopeRoute />;
  }

  return <RepositorySettingsScreen scope={scope} />;
}
