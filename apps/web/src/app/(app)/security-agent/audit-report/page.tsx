import { Suspense } from 'react';
import { SecurityAuditReportPage } from '@/components/security-agent/SecurityAuditReportPage';

export default function AuditReportPage() {
  return (
    <Suspense
      fallback={
        <div className="text-muted-foreground block py-16 text-center text-sm">
          Loading audit report...
        </div>
      }
    >
      <SecurityAuditReportPage />
    </Suspense>
  );
}
