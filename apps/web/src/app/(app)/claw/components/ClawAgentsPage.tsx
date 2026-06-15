'use client';

import { AlertTriangle, Bot } from 'lucide-react';
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
  // Each agent operation advertises its own capability — gate read AND each
  // mutation control independently so a controller that supports reads but not
  // a given write never shows a control that can only fail.
  const capabilities = controllerVersionOk(versionQuery.data)?.capabilities;
  const has = (cap: string) => capabilities?.includes(cap) === true;
  const supportsAgentsRead = has('config.agents.read');

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
    content = (
      <AgentsSection
        enabled={false}
        instanceId={status?.instanceId ?? null}
        canCreate={false}
        canUpdate={false}
        canDelete={false}
        canBindings={false}
        canEditDefaults={false}
      />
    );
  } else if (versionQuery.isLoading) {
    content = <LoadingCard />;
  } else if (versionQuery.error) {
    // Distinguish a transient/operational version-read failure from a genuinely
    // unsupported machine — don't tell an admin to "upgrade" on a network blip.
    content = (
      <Card>
        <CardContent className="py-12 text-center">
          <p className="text-destructive text-sm">
            Couldn’t determine this machine’s capabilities. Try again in a moment.
          </p>
        </CardContent>
      </Card>
    );
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
    content = (
      <AgentsSection
        enabled
        instanceId={status?.instanceId ?? null}
        canCreate={has('config.agents.create.basic.cli')}
        canUpdate={has('config.agents.update')}
        canDelete={has('config.agents.delete.cli')}
        canBindings={has('config.agents.bindings.update')}
        canEditDefaults={has('config.agent-defaults.update')}
      />
    );
  }

  const body = (
    <div className="flex flex-col gap-4">
      <div className="rounded-md border border-yellow-500/20 bg-yellow-500/5 px-3 py-2">
        <p className="flex items-center gap-1.5 text-xs font-medium text-yellow-400">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          Internal · work in progress
        </p>
        <p className="text-muted-foreground mt-1 text-xs">
          Agent management is admin-only and shipped to production for limited testing. Expect rough
          edges, and behavior may change.
        </p>
      </div>
      {content}
    </div>
  );

  // Personal context uses BillingWrapper for access-lock dialogs/banners.
  return organizationId ? body : <BillingWrapper>{body}</BillingWrapper>;
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
