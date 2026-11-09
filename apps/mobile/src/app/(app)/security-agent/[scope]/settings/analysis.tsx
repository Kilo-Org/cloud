import {
  InvalidSecurityScopeRoute,
  useSecurityAgentScope,
} from '@/components/security-agent/security-agent-scope-route';
import { AnalysisSettingsScreen } from '@/components/security-agent/analysis-settings-screen';

export default function SecurityAgentAnalysisSettingsRoute() {
  const scope = useSecurityAgentScope();

  if (!scope) {
    return <InvalidSecurityScopeRoute />;
  }

  return <AnalysisSettingsScreen scope={scope} />;
}
