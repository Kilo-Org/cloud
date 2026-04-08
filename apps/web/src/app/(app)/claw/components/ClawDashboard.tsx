'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Sparkles, TriangleAlert, X, Zap } from 'lucide-react';
import type { KiloClawDashboardStatus } from '@/lib/kiloclaw/types';
import { useKiloClawGatewayStatus, useKiloClawMutations } from '@/hooks/useKiloClaw';
import { useOrgKiloClawGatewayStatus, useOrgKiloClawMutations } from '@/hooks/useOrgKiloClaw';
import { useClawServiceDegraded } from '../hooks/useClawHooks';
import { ClawContextProvider, useClawContext } from './ClawContext';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useGatewayUrl } from '../hooks/useGatewayUrl';
import { ClawHeader } from './ClawHeader';
import { CreateInstanceCard } from './CreateInstanceCard';
import { InstanceControls } from './InstanceControls';
import { InstanceTab } from './InstanceTab';
import { ChangelogTab } from './ChangelogTab';
import { SubscriptionTab } from './SubscriptionTab';
import { ChannelPairingStep } from './ChannelPairingStep';
import { BotIdentityStep } from './BotIdentityStep';
import { ChannelSelectionStepView } from './ChannelSelectionStep';
import { PermissionStep } from './PermissionStep';
import { ProvisioningStep } from './ProvisioningStep';
import type { BotIdentity, ExecPreset } from './claw.types';
import { BillingWrapper } from './billing/BillingWrapper';

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
  isNewSetup,
  onNewSetupChange,
  organizationId,
}: {
  status: KiloClawDashboardStatus | undefined;
  isNewSetup: boolean;
  onNewSetupChange: (v: boolean) => void;
  organizationId?: string;
}) {
  return (
    <ClawContextProvider organizationId={organizationId}>
      <ClawDashboardInner
        status={status}
        isNewSetup={isNewSetup}
        onNewSetupChange={onNewSetupChange}
      />
    </ClawContextProvider>
  );
}

function ClawDashboardInner({
  status,
  isNewSetup,
  onNewSetupChange,
}: {
  status: KiloClawDashboardStatus | undefined;
  isNewSetup: boolean;
  onNewSetupChange: (v: boolean) => void;
}) {
  const { organizationId } = useClawContext();

  // Hook calls are unconditional — both personal and org variants are called,
  // but only the appropriate one is enabled. This satisfies React hook rules.
  // useOrgKiloClawMutations wraps org mutations to match the personal type
  // signature (pre-binds organizationId into each mutation's mutate/mutateAsync).
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
  const configServiceNudgeVisible = !instanceStatus || instanceYoung;

  const VALID_TABS = ['instance', 'subscription', 'changelog'] as const;
  type TabValue = (typeof VALID_TABS)[number];

  function tabFromHash(): TabValue {
    if (typeof window === 'undefined') return 'instance';
    const hash = window.location.hash.slice(1);
    return VALID_TABS.includes(hash as TabValue) ? (hash as TabValue) : 'instance';
  }

  const [activeTab, setActiveTab] = useState<TabValue>(tabFromHash);

  function handleTabChange(value: string) {
    setActiveTab(value as TabValue);
    const basePath = organizationId ? `/organizations/${organizationId}/claw` : '/claw';
    window.history.replaceState(null, '', value === 'instance' ? basePath : `${basePath}#${value}`);
  }

  useEffect(() => {
    function onHashChange() {
      setActiveTab(tabFromHash());
    }
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const [onboardingStep, setOnboardingStep] = useState<
    'identity' | 'permissions' | 'channels' | 'provisioning' | 'pairing' | 'done'
  >('identity');
  const [selectedPreset, setSelectedPreset] = useState<ExecPreset | null>(null);
  const [botIdentity, setBotIdentity] = useState<BotIdentity | null>(null);
  const [channelTokens, setChannelTokens] = useState<Record<string, string> | null>(null);
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);
  const hasPairingStep = selectedChannelId === 'telegram' || selectedChannelId === 'discord';

  // Reset onboarding wizard to step 1 whenever we enter setup mode so that
  // a destroy → re-provision cycle always starts fresh.
  const prevIsNewSetup = useRef(isNewSetup);
  useEffect(() => {
    if (isNewSetup && !prevIsNewSetup.current) {
      setOnboardingStep('identity');
      setSelectedPreset(null);
      setBotIdentity(null);
      setChannelTokens(null);
      setSelectedChannelId(null);
    }
    prevIsNewSetup.current = isNewSetup;
  }, [isNewSetup]);

  const [upgradeRequested, setUpgradeRequested] = useState(false);
  const onUpgradeHandled = useCallback(() => setUpgradeRequested(false), []);

  // Called by InstanceControls after a successful redeploy/upgrade action.
  const onRedeploySuccess = useCallback(() => {}, []);

  // Billing gating (welcome page for new users, loading spinner) is handled
  // by page.tsx before this component mounts. ClawDashboard always renders
  // the full dashboard with BillingWrapper handling lock dialogs and banners.

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
        isSetupWizard={isNewSetup}
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

      {configServiceNudgeVisible && !isNewSetup && !organizationId && (
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

      <MaybeBillingWrapper skip={!!organizationId} hideBanners={isNewSetup}>
        {!instanceStatus ? (
          <CreateInstanceCard
            mutations={mutations}
            onProvisionStart={() => onNewSetupChange(true)}
            onProvisionFailed={() => onNewSetupChange(false)}
          />
        ) : isNewSetup && onboardingStep === 'identity' ? (
          <BotIdentityStep
            instanceRunning={isRunning && gatewayStatus?.state === 'running'}
            onContinue={identity => {
              setBotIdentity(identity);
              setOnboardingStep('permissions');
            }}
          />
        ) : isNewSetup && onboardingStep === 'permissions' ? (
          <PermissionStep
            instanceRunning={isRunning && gatewayStatus?.state === 'running'}
            onSelect={preset => {
              setSelectedPreset(preset);
              setOnboardingStep('channels');
            }}
          />
        ) : isNewSetup && onboardingStep === 'channels' ? (
          <ChannelSelectionStepView
            instanceRunning={isRunning && gatewayStatus?.state === 'running'}
            onSelect={(channelId, tokens) => {
              setSelectedChannelId(channelId);
              setChannelTokens(tokens);
              setOnboardingStep('provisioning');
            }}
            onSkip={() => {
              setSelectedChannelId(null);
              setChannelTokens(null);
              setOnboardingStep('provisioning');
            }}
          />
        ) : isNewSetup && onboardingStep === 'provisioning' && selectedPreset ? (
          <ProvisioningStep
            preset={selectedPreset}
            channelTokens={channelTokens}
            botIdentity={botIdentity}
            instanceRunning={isRunning && gatewayStatus?.state === 'running'}
            mutations={mutations}
            totalSteps={hasPairingStep ? 6 : 5}
            onComplete={() => setOnboardingStep(hasPairingStep ? 'pairing' : 'done')}
          />
        ) : isNewSetup &&
          onboardingStep === 'pairing' &&
          (selectedChannelId === 'telegram' || selectedChannelId === 'discord') ? (
          <ChannelPairingStep
            channelId={selectedChannelId}
            mutations={mutations}
            onComplete={() => setOnboardingStep('done')}
            onSkip={() => setOnboardingStep('done')}
          />
        ) : isNewSetup ? (
          <Card className="mt-6 overflow-hidden">
            <CardContent className="flex flex-col items-center justify-center gap-6 pt-12">
              <div className="relative">
                <div className="flex h-20 w-20 items-center justify-center rounded-2xl border border-emerald-700/30 bg-emerald-900/50">
                  <div className="flex h-12 w-12 items-center justify-center rounded-full border-2 border-emerald-500">
                    <Check className="h-6 w-6 text-emerald-500" />
                  </div>
                </div>
                <div className="absolute -top-3 -right-3 flex h-6 w-6 items-center justify-center rounded-full bg-[#09090b] text-amber-400">
                  <Sparkles className="h-4 w-4" />
                </div>
              </div>

              <div className="flex flex-col items-center gap-2">
                <h2 className="text-2xl font-bold">Your instance is ready!</h2>
                <p className="text-muted-foreground max-w-md text-center">
                  KiloClaw has been provisioned and configured with your settings. You&apos;re all
                  set to start.
                </p>
              </div>

              {instanceStatus?.flyRegion && (
                <div className="border-border/50 flex items-center gap-2 rounded-full border px-4 py-2">
                  <span className="relative flex h-1.5 w-1.5">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
                    <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
                  </span>
                  <span className="text-muted-foreground flex items-center gap-2 text-sm">
                    Active ·{' '}
                    <span className="text-foreground font-bold">
                      {instanceStatus.flyRegion.toUpperCase()}
                    </span>{' '}
                    region
                  </span>
                </div>
              )}
              <div className="flex w-full flex-col gap-3">
                {gatewayStatus?.state === 'running' && (
                  <Button
                    variant="primary"
                    className="w-full min-w-[180px] bg-emerald-600 py-6 text-base text-white hover:bg-emerald-700"
                    onClick={() => {
                      const base = organizationId
                        ? `/organizations/${organizationId}/claw`
                        : '/claw';
                      window.location.href = `${base}/chat`;
                    }}
                  >
                    Open KiloClaw
                  </Button>
                )}
                <Button
                  className="w-full py-6 text-base"
                  variant="outline"
                  onClick={() => onNewSetupChange(false)}
                >
                  <X className="mr-2 h-4 w-4" />
                  Close Wizard
                </Button>
              </div>
            </CardContent>
          </Card>
        ) : (
          <Card className="mt-6">
            <CardContent className="border-b p-5">
              <InstanceControls
                status={instanceStatus}
                mutations={mutations}
                onRedeploySuccess={onRedeploySuccess}
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
                  <TabsTrigger value="changelog" className={tabTriggerClass}>
                    What&apos;s New <Sparkles className="ml-1 inline h-3 w-3 text-amber-400" />
                  </TabsTrigger>
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
                <TabsContent value="changelog" className="mt-0">
                  <ChangelogTab />
                </TabsContent>
              </CardContent>
            </Tabs>
          </Card>
        )}
      </MaybeBillingWrapper>
    </div>
  );
}
