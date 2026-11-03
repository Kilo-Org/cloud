import {
  InvalidSecurityScopeRoute,
  useSecurityAgentScope,
} from '@/components/security-agent/security-agent-scope-route';
import { AuditReportScreen } from '@/components/security-agent/audit-report-screen';

export default function SecurityAgentAuditReportRoute() {
  const scope = useSecurityAgentScope();

  if (!scope) {
    return <InvalidSecurityScopeRoute />;
  }

  return <AuditReportScreen scope={scope} />;
}
