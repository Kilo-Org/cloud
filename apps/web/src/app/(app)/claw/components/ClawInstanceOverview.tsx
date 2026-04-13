'use client';

import { TriangleAlert } from 'lucide-react';
import type { KiloClawDashboardStatus } from '@/lib/kiloclaw/types';
import { useKiloClawGatewayStatus, useKiloClawMutations } from '@/hooks/useKiloClaw';
import { useOrgKiloClawGatewayStatus, useOrgKiloClawMutations } from '@/hooks/useOrgKiloClaw';
import { useClawServiceDegraded } from '../hooks/useClawHooks';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardContent } from '@/components/ui/card';
import { InstanceControls } from './InstanceControls';
import { InstanceTab } from './InstanceTab';
import { useClawContext } from './ClawContext';

export function ClawInstanceOverview({ status }: { status: KiloClawDashboardStatus }) {
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
    data: gatewayStatus,
    isLoading: gatewayLoading,
    error: gatewayError,
  } = organizationId ? orgGateway : personalGateway;

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

      <Card>
        <CardContent className="border-b p-5">
          <InstanceControls
            status={status}
            mutations={mutations}
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
