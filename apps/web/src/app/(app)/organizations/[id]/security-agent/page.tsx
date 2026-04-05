'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { Loader2 } from 'lucide-react';
import { useSecurityAgent } from '@/components/security-agent/SecurityAgentContext';
import { SecurityDashboard } from '@/components/security-agent/SecurityDashboard';

export default function OrgSecurityAgentDashboardPage() {
  const { hasIntegration, isEnabled, isLoadingConfig, organizationId } = useSecurityAgent();
  const router = useRouter();

  const shouldRedirectToConfig = hasIntegration && isEnabled === false && !!organizationId;

  useEffect(() => {
    if (shouldRedirectToConfig) {
      router.replace(`/organizations/${organizationId}/security-agent/config`);
    }
  }, [shouldRedirectToConfig, organizationId, router]);

  if (shouldRedirectToConfig) {
    return null;
  }

  if (hasIntegration && isLoadingConfig) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="text-muted-foreground h-8 w-8 animate-spin" />
      </div>
    );
  }

  return <SecurityDashboard />;
}
