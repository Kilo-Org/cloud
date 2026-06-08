'use client';

import { Bot } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';

import { SetPageTitle } from '@/components/SetPageTitle';
import { controllerVersionOk } from '@/lib/kiloclaw/types';
import { Card, CardContent } from '@/components/ui/card';
import { useKiloClawStatus } from '@/hooks/useKiloClaw';
import { useOrgKiloClawStatus } from '@/hooks/useOrgKiloClaw';
import { useUser } from '@/hooks/useUser';

import { useClawControllerVersion } from '../hooks/useClawHooks';
import { AgentsSection } from './AgentsSection';
import { BillingWrapper } from './billing/BillingWrapper';
import { ClawContextProvider } from './ClawContext';

/**
 * Polls instance status and handles loading / error / no-instance before
 * rendering the agents view. Mirrors ClawSettingsWithStatus, trimmed to the
 * read-only needs of this page.
 */
function LoadingCard() {
  return (
    <Card>
      <CardContent className="py-12 text-center">
        <p className="text-muted-foreground">Loading…</p>
      </CardContent>
    </Card>
  );
}

function ClawAgentsWithStatus({ organizationId }: { organizationId?: string }) {
  const router = useRouter();
  // Disable the inactive status hook so it doesn't keep polling on the other context.
  const personalStatus = useKiloClawStatus({ enabled: !organizationId });
  const orgStatus = useOrgKiloClawStatus(organizationId);
  const { data: status, isLoading, error } = organizationId ? orgStatus : personalStatus;

  // Agent management is admin-only. Fail CLOSED: proceed only on a confirmed
  // is_admin. A null or errored user query (admin status unknown) bounces to
  // settings, the same as a non-admin. (The nav item is also gated on is_admin.)
  const { data: user, isLoading: userLoading } = useUser();
  const notAdmin = !userLoading && user?.is_admin !== true;
  const settingsUrl = organizationId
    ? `/organizations/${organizationId}/claw/settings`
    : '/claw/settings';
  useEffect(() => {
    if (notAdmin) {
      router.replace(settingsUrl);
    }
  }, [notAdmin, settingsUrl, router]);

  // The agent endpoints ship behind a controller capability; older machine
  // images don't advertise it and return 501. Gate on it so historical
  // instances see an upgrade prompt rather than a broken page.
  const running = status?.status === 'running';
  const versionQuery = useClawControllerVersion(running);
  const supportsAgentsRead =
    controllerVersionOk(versionQuery.data)?.capabilities?.includes('config.agents.read') === true;

  const clawUrl = organizationId ? `/organizations/${organizationId}/claw/new` : '/claw/new';
  const shouldRedirect = !isLoading && !error && (!status || status.status === null);
  useEffect(() => {
    if (shouldRedirect) {
      router.replace(clawUrl);
    }
  }, [shouldRedirect, clawUrl, router]);

  if (userLoading || notAdmin || isLoading || shouldRedirect) {
    return <LoadingCard />;
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

  let content: ReactNode;
  if (!running) {
    // Machine stopped — AgentsSection renders the "start your machine" hint.
    content = <AgentsSection enabled={false} />;
  } else if (versionQuery.isLoading) {
    content = <LoadingCard />;
  } else if (!supportsAgentsRead) {
    content = (
      <Card>
        <CardContent className="py-12 text-center">
          <p className="text-muted-foreground text-sm">
            Agent management is not available on this machine version. Update your machine to enable
            it.
          </p>
        </CardContent>
      </Card>
    );
  } else {
    content = <AgentsSection enabled />;
  }

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
