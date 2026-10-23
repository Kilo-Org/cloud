import { useLocalSearchParams } from 'expo-router';

import { AuditReportScreen } from '@/components/security-agent/audit-report-screen';

export default function SecurityAgentAuditReportRoute() {
  const { scope } = useLocalSearchParams<{ scope: string }>();
  return <AuditReportScreen scope={scope} />;
}
