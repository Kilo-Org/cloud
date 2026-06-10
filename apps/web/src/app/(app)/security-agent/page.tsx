'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { Loader2 } from 'lucide-react';
import { useSecurityAgent } from '@/components/security-agent/SecurityAgentContext';
import { SecurityDashboard } from '@/components/security-agent/SecurityDashboard';

export default function SecurityAgentDashboardPage() {
  const { hasIntegration, isEnabled, isLoadingConfig } = useSecurityAgent();
  const router = useRouter();

  // Redirect per truth table:
  // No integration -> show dashboard with install CTA (handled by SecurityDashboard)
  // Installed + disabled -> redirect to config
  // Installed + enabled -> show dashboard
  // isEnabled is undefined while config is loading — wait before deciding
  const shouldRedirectToConfig = hasIntegration && isEnabled === false;

  useEffect(() => {
    if (shouldRedirectToConfig) {
      router.replace('/security-agent/config');
    }
  }, [shouldRedirectToConfig, router]);

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
