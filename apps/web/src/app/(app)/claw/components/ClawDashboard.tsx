'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { TriangleAlert, Zap } from 'lucide-react';
import type { KiloClawDashboardStatus } from '@/lib/kiloclaw/types';
import { useKiloClawGatewayStatus, useKiloClawMutations } from '@/hooks/useKiloClaw';
import { useOrgKiloClawGatewayStatus, useOrgKiloClawMutations } from '@/hooks/useOrgKiloClaw';
import { useClawServiceDegraded } from '../hooks/useClawHooks';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardContent } from '@/components/ui/card';
import { useGatewayUrl } from '../hooks/useGatewayUrl';
import { ClawHeader } from './ClawHeader';
import { InstanceControls } from './InstanceControls';
import { InstanceTab } from './InstanceTab';
import { BillingWrapper } from './billing/BillingWrapper';
import { ClawContextProvider, useClawContext } from './ClawContext';

function MaybeBillingWrapper({
  skip,
  hideBanners,
  children,
}: {
  skip: boolean;
  hideBanners: boolean;
  children: React.ReactNode;
}) {
  if (skip) return <>{children}</>;
  return <BillingWrapper hideBanners={hideBanners}>{children}</BillingWrapper>;
}

type PopulatedClawStatus = KiloClawDashboardStatus & {
  status: NonNullable<KiloClawDashboardStatus['status']>;
};

function hasPopulatedStatus(
  candidate: KiloClawDashboardStatus | undefined
): candidate is PopulatedClawStatus {
  return candidate !== undefined && candidate.status !== null;
}

export function ClawDashboard({
  status,
  organizationId,
}: {
  status: KiloClawDashboardStatus | undefined;
  organizationId?: string;
}) {
  return (
    <ClawContextProvider organizationId={organizationId}>
      <ClawDashboardInner status={status} />
    </ClawContextProvider>
  );
}

function ClawDashboardInner({ status }: { status: KiloClawDashboardStatus | undefined }) {
  const router = useRouter();
  const { organizationId } = useClawContext();

  const personalMutations = useKiloClawMutations();
  const orgMutations = useOrgKiloClawMutations(organizationId ?? '');
  const mutations = organizationId ? orgMutations : personalMutations;

  const gatewayUrl = useGatewayUrl(status);
  const instanceStatus = hasPopulatedStatus(status) ? status : null;
  const isRunning = instanceStatus?.status === 'running';

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
    instanceStatus !== null &&
    instanceStatus.provisionedAt !== null &&
    Date.now() - instanceStatus.provisionedAt < SEVEN_DAYS_MS;
  const configServiceNudgeVisible = instanceYoung;

  const basePath = organizationId ? `/organizations/${organizationId}/claw` : '/claw';
  const setupPath = `${basePath}/new`;

  useEffect(() => {
    if (!instanceStatus) {
      router.replace(setupPath);
    }
  }, [instanceStatus, router, setupPath]);

  const [upgradeRequested, setUpgradeRequested] = useState(false);
  const onUpgradeHandled = useCallback(() => setUpgradeRequested(false), []);

  // Billing gating (welcome page for new users, loading spinner) is handled
  // by page.tsx before this component mounts. ClawDashboard always renders
  // the full dashboard with BillingWrapper handling lock dialogs and banners.

  return (
    <div className="container m-auto flex w-full max-w-[1140px] flex-col gap-6 p-4 md:p-6">
      <ClawHeader
        status={status?.status || null}
        sandboxId={status?.sandboxId || null}
        region={status?.flyRegion || null}
        gatewayUrl={gatewayUrl}
        gatewayReady={gatewayStatus?.state === 'running'}
      />

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

      {configServiceNudgeVisible && instanceStatus && !organizationId && (
        <div className="border-violet-500/30 bg-violet-500/10 flex flex-col gap-3 rounded-xl border p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <Zap className="text-violet-400 mt-0.5 h-5 w-5 shrink-0" />
            <div>
              <p className="text-violet-400 text-sm font-semibold">
                Go from inbox chaos to an AI executive assistant — in one hour.
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

      <MaybeBillingWrapper skip={!!organizationId} hideBanners={false}>
        {!instanceStatus ? (
          <Card className="mt-6">
            <CardContent className="py-12 text-center">
              <p className="text-muted-foreground">Redirecting to setup...</p>
            </CardContent>
          </Card>
        ) : (
          <Card className="mt-6">
            <CardContent className="border-b p-5">
              <InstanceControls
                status={instanceStatus}
                mutations={mutations}
                upgradeRequested={upgradeRequested}
                onUpgradeHandled={onUpgradeHandled}
              />
            </CardContent>
            <CardContent className="p-5">
              <InstanceTab
                status={instanceStatus}
                gatewayStatus={gatewayStatus}
                gatewayLoading={gatewayLoading}
                gatewayError={gatewayError}
              />
            </CardContent>
          </Card>
        )}
      </MaybeBillingWrapper>
    </div>
  );
}
