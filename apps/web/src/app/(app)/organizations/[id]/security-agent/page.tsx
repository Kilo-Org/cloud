'use client';

import { redirect } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { useSecurityAgent } from '@/components/security-agent/SecurityAgentContext';
import { SecurityDashboard } from '@/components/security-agent/SecurityDashboard';

export default function OrgSecurityAgentDashboardPage() {
  const { hasIntegration, isEnabled, isLoadingConfig, isLoadingPermission, organizationId } =
    useSecurityAgent();

  const shouldRedirectToConfig =
    !!organizationId &&
    ((!isLoadingPermission && !hasIntegration) || (hasIntegration && isEnabled === false));

  if (shouldRedirectToConfig) {
    redirect(`/organizations/${organizationId}/security-agent/config`);
  }

  if (isLoadingPermission || (hasIntegration && isLoadingConfig)) {
    return (
      <div className="text-muted-foreground flex items-center justify-center gap-2 py-16 text-sm">
        <Loader2 className="size-6 animate-spin motion-reduce:animate-none" aria-hidden="true" />
        Loading Security Agent...
      </div>
    );
  }

  return <SecurityDashboard />;
}
