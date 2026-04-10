'use client';

import { TriangleAlert, Zap } from 'lucide-react';
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

  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
  const instanceYoung =
    status.provisionedAt !== null && Date.now() - status.provisionedAt < SEVEN_DAYS_MS;
  const configServiceNudgeVisible = instanceYoung;

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

      {configServiceNudgeVisible && !organizationId && (
        <div className="border-violet-500/30 bg-violet-500/10 flex flex-col gap-3 rounded-xl border p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <Zap className="text-violet-400 mt-0.5 h-5 w-5 shrink-0" />
            <div>
              <p className="text-violet-400 text-sm font-semibold">
                Go from inbox chaos to an AI executive assistant - in one hour.
              </p>
              <p className="text-muted-foreground mt-0.5 text-sm">
                A KiloClaw expert configures your email, calendar, and messaging live on a call.
                Includes <b>2 months free</b> hosting.
              </p>
            </div>
          </div>
          <a
            href="https://kilo.ai/kiloclaw/config-service"
            target="_blank"
            rel="noopener noreferrer"
            className="bg-violet-500 text-white hover:bg-violet-500/90 inline-flex shrink-0 items-center justify-center rounded-md px-4 py-2 text-sm font-medium transition-colors"
          >
            Book your session
          </a>
        </div>
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
