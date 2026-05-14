'use client';

import { TriangleAlert } from 'lucide-react';
import type { KiloClawDashboardStatus } from '@/lib/kiloclaw/types';
import { gatewayStatusOk } from '@/lib/kiloclaw/types';
import { useKiloClawGatewayStatus, useKiloClawMutations } from '@/hooks/useKiloClaw';
import { useOrgKiloClawGatewayStatus, useOrgKiloClawMutations } from '@/hooks/useOrgKiloClaw';
import { useClawServiceDegraded } from '../hooks/useClawHooks';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardContent } from '@/components/ui/card';
import { InstanceControls } from './InstanceControls';
import { InstanceTab } from './InstanceTab';
import { KiloClawScheduledActionBanner } from './KiloClawScheduledActionBanner';
import { useClawContext } from './ClawContext';

export function ClawInstanceOverview({
  status,
  onRedeploySuccess,
  onRequestUpgrade,
}: {
  status: KiloClawDashboardStatus;
  onRedeploySuccess?: () => void;
  onRequestUpgrade?: () => void;
}) {
  const { organizationId } = useClawContext();

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
    data: gatewayStatusRaw,
    isLoading: gatewayLoading,
    error: gatewayError,
  } = organizationId ? orgGateway : personalGateway;
  // Narrow off the instance-not-running sentinel returned by the worker
  // when DO state isn't `running`. Downstream consumers expect the OK shape.
  const gatewayStatus = gatewayStatusOk(gatewayStatusRaw);

  const { data: isServiceDegraded } = useClawServiceDegraded();

  return (
    <>
      {isServiceDegraded && (
        <Alert variant="warning">
          <TriangleAlert className="size-4" />
          <AlertDescription>
            <span>
              KiloClaw is really popular today. If you run into issues,{' '}
              <a
                href="https://status.kilo.ai/"
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:opacity-80"
              >
                check our status page
              </a>{' '}
              for live updates.
            </span>
          </AlertDescription>
        </Alert>
      )}

      <KiloClawScheduledActionBanner
        scheduledAction={status.scheduledAction}
        instanceName={status.name}
      />

      <Card>
        <CardContent className="border-b p-5">
          <InstanceControls
            status={status}
            mutations={mutations}
            onRedeploySuccess={onRedeploySuccess}
            onRequestUpgrade={onRequestUpgrade}
            gatewayReady={gatewayStatus?.state === 'running'}
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
    </>
  );
}
