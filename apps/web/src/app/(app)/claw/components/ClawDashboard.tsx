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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useGatewayUrl } from '../hooks/useGatewayUrl';
import { ClawHeader } from './ClawHeader';
import { InstanceControls } from './InstanceControls';
import { InstanceTab } from './InstanceTab';
import { SubscriptionTab } from './SubscriptionTab';
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

  const VALID_TABS = ['instance', 'subscription'] as const;
  type TabValue = (typeof VALID_TABS)[number];

  function tabFromHash(): TabValue {
    if (typeof window === 'undefined') return 'instance';
    const hash = window.location.hash.slice(1);
    return VALID_TABS.includes(hash as TabValue) ? (hash as TabValue) : 'instance';
  }

  const [activeTab, setActiveTab] = useState<TabValue>(tabFromHash);
  const basePath = organizationId ? `/organizations/${organizationId}/claw` : '/claw';
  const setupPath = `${basePath}/new`;

  useEffect(() => {
    if (!instanceStatus) {
      router.replace(setupPath);
    }
  }, [instanceStatus, router, setupPath]);

  function handleTabChange(value: string) {
    setActiveTab(value as TabValue);
    window.history.replaceState(null, '', value === 'instance' ? basePath : `${basePath}#${value}`);
  }

  useEffect(() => {
    function onHashChange() {
      setActiveTab(tabFromHash());
    }
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const [upgradeRequested, setUpgradeRequested] = useState(false);
  const onUpgradeHandled = useCallback(() => setUpgradeRequested(false), []);

  const tabTriggerClass =
    'border-border text-muted-foreground hover:bg-muted hover:text-foreground data-[state=active]:bg-muted data-[state=active]:text-foreground rounded-md border px-4 py-2 text-sm font-medium transition-colors data-[state=active]:shadow-none';

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
            <Tabs value={activeTab} onValueChange={handleTabChange}>
              <div className="px-5">
                <TabsList className="mt-4 h-auto w-full justify-start gap-2 overflow-x-auto rounded-none border-b bg-transparent p-0 pb-3">
                  <TabsTrigger value="instance" className={tabTriggerClass}>
                    Gateway Process
                  </TabsTrigger>
                  {!organizationId && (
                    <TabsTrigger value="subscription" className={tabTriggerClass}>
                      Subscription
                    </TabsTrigger>
                  )}
                </TabsList>
              </div>
              <CardContent className="p-5">
                <TabsContent value="instance" className="mt-0">
                  <InstanceTab
                    status={instanceStatus}
                    gatewayStatus={gatewayStatus}
                    gatewayLoading={gatewayLoading}
                    gatewayError={gatewayError}
                  />
                </TabsContent>
                <TabsContent value="subscription" className="mt-0">
                  <SubscriptionTab />
                </TabsContent>
              </CardContent>
            </Tabs>
          </Card>
        )}
      </MaybeBillingWrapper>
    </div>
  );
}
