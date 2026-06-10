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
    return (
      <div className="text-muted-foreground block py-16 text-center text-sm">
        Opening settings...
      </div>
    );
  }

  if (hasIntegration && isLoadingConfig) {
    return (
      <div className="text-muted-foreground flex items-center justify-center gap-2 py-16 text-sm">
        <Loader2 className="size-6 animate-spin motion-reduce:animate-none" aria-hidden="true" />
        Loading Security Agent...
      </div>
    );
  }

  return <SecurityDashboard />;
}
