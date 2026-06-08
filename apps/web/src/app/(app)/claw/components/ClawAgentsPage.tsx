'use client';

import { Bot } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

import { SetPageTitle } from '@/components/SetPageTitle';
import { Card, CardContent } from '@/components/ui/card';
import { useKiloClawStatus } from '@/hooks/useKiloClaw';
import { useOrgKiloClawStatus } from '@/hooks/useOrgKiloClaw';

import { AgentsSection } from './AgentsSection';
import { BillingWrapper } from './billing/BillingWrapper';
import { ClawContextProvider } from './ClawContext';

/**
 * Polls instance status and handles loading / error / no-instance before
 * rendering the agents view. Mirrors ClawSettingsWithStatus, trimmed to the
 * read-only needs of this page.
 */
function ClawAgentsWithStatus({ organizationId }: { organizationId?: string }) {
  const router = useRouter();
  const personalStatus = useKiloClawStatus();
  const orgStatus = useOrgKiloClawStatus(organizationId);
  const { data: status, isLoading, error } = organizationId ? orgStatus : personalStatus;

  const clawUrl = organizationId ? `/organizations/${organizationId}/claw/new` : '/claw/new';
  const shouldRedirect = !isLoading && !error && (!status || status.status === null);
  useEffect(() => {
    if (shouldRedirect) {
      router.replace(clawUrl);
    }
  }, [shouldRedirect, clawUrl, router]);

  if (isLoading || shouldRedirect) {
    return (
      <Card>
        <CardContent className="py-12 text-center">
          <p className="text-muted-foreground">Loading…</p>
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardContent className="py-12 text-center">
          <p className="text-destructive text-sm">
            Failed to load status: {error instanceof Error ? error.message : 'Unknown error'}
          </p>
        </CardContent>
      </Card>
    );
  }

  if (!status || status.status === null) return null;

  const content = <AgentsSection enabled={status.status === 'running'} />;

  // Personal context uses BillingWrapper for access-lock dialogs/banners.
  return organizationId ? content : <BillingWrapper>{content}</BillingWrapper>;
}

export function ClawAgentsPage({ organizationId }: { organizationId?: string }) {
  return (
    <ClawContextProvider organizationId={organizationId}>
      <div className="container m-auto flex w-full max-w-[1140px] flex-col gap-6 p-4 md:p-6">
        <SetPageTitle title="Agents" icon={<Bot className="text-muted-foreground h-4 w-4" />} />
        <ClawAgentsWithStatus organizationId={organizationId} />
      </div>
    </ClawContextProvider>
  );
}
