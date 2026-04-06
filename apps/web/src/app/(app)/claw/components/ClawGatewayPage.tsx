'use client';

import { useCallback, useEffect, useState } from 'react';
import { Cpu } from 'lucide-react';
import { useRouter } from 'next/navigation';
import type { KiloClawDashboardStatus } from '@/lib/kiloclaw/types';
import {
  useKiloClawGatewayStatus,
  useKiloClawMutations,
  useKiloClawStatus,
} from '@/hooks/useKiloClaw';
import {
  useOrgKiloClawGatewayStatus,
  useOrgKiloClawMutations,
  useOrgKiloClawStatus,
} from '@/hooks/useOrgKiloClaw';
import { ClawContextProvider, useClawContext } from './ClawContext';
import { InstanceControls } from './InstanceControls';
import { InstanceTab } from './InstanceTab';
import { BillingWrapper } from './billing/BillingWrapper';
import { SetPageTitle } from '@/components/SetPageTitle';
import { Card, CardContent } from '@/components/ui/card';

function ClawGatewayInner({ status }: { status: KiloClawDashboardStatus }) {
  const { organizationId } = useClawContext();
  const [upgradeRequested, setUpgradeRequested] = useState(false);

  const personalMutations = useKiloClawMutations();
  const orgMutations = useOrgKiloClawMutations(organizationId ?? '');
  const mutations = organizationId ? orgMutations : personalMutations;

  const isRunning = status.status === 'running';

  const personalGateway = useKiloClawGatewayStatus(!organizationId && isRunning);
  const orgGateway = useOrgKiloClawGatewayStatus(
    organizationId ?? '',
    !!organizationId && isRunning
  );
  const {
    data: gatewayStatus,
    isLoading: gatewayLoading,
    error: gatewayError,
  } = organizationId ? orgGateway : personalGateway;

  const onUpgradeHandled = useCallback(() => setUpgradeRequested(false), []);

  const onRedeploySuccess = useCallback(() => {}, []);

  const gatewayContent = (
    <Card>
      <CardContent className="border-b p-5">
        <InstanceControls
          status={status}
          mutations={mutations}
          onRedeploySuccess={onRedeploySuccess}
          upgradeRequested={upgradeRequested}
          onUpgradeHandled={onUpgradeHandled}
        />
      </CardContent>
      <CardContent className="p-5">
        <InstanceTab
          status={status}
          gatewayStatus={gatewayStatus}
          gatewayLoading={gatewayLoading}
          gatewayError={gatewayError}
        />
      </CardContent>
    </Card>
  );

  if (!organizationId) {
    return <BillingWrapper>{gatewayContent}</BillingWrapper>;
  }

  return gatewayContent;
}

function ClawGatewayWithStatus({ organizationId }: { organizationId?: string }) {
  const router = useRouter();
  const personalStatus = useKiloClawStatus();
  const orgStatus = useOrgKiloClawStatus(organizationId ?? '');
  const { data: status, isLoading, error } = organizationId ? orgStatus : personalStatus;

  const clawUrl = organizationId ? `/organizations/${organizationId}/claw/new` : '/claw/new';

  const shouldRedirect = !isLoading && !error && (!status || status.status === null);
  useEffect(() => {
    if (shouldRedirect) {
      router.replace(clawUrl);
    }
  }, [shouldRedirect, clawUrl, router]);

  if (isLoading) {
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

  return <ClawGatewayInner status={status} />;
}

export function ClawGatewayPage({ organizationId }: { organizationId?: string }) {
  return (
    <ClawContextProvider organizationId={organizationId}>
      <div className="container m-auto flex w-full max-w-[1140px] flex-col gap-6 p-4 md:p-6">
        <SetPageTitle title="Gateway" icon={<Cpu className="text-muted-foreground h-4 w-4" />} />
        <ClawGatewayWithStatus organizationId={organizationId} />
      </div>
    </ClawContextProvider>
  );
}
