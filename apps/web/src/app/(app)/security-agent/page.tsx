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
