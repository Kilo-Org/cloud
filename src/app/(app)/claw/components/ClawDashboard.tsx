'use client';

import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { Check, Sparkles, TriangleAlert, X, Zap } from 'lucide-react';
import type { KiloClawDashboardStatus } from '@/lib/kiloclaw/types';
import {
  useKiloClawGatewayStatus,
  useKiloClawMutations,
  useKiloClawServiceDegraded,
} from '@/hooks/useKiloClaw';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useGatewayUrl } from '../hooks/useGatewayUrl';
import { ClawHeader } from './ClawHeader';
import { CreateInstanceCard } from './CreateInstanceCard';
import { InstanceControls } from './InstanceControls';
import { InstanceTab } from './InstanceTab';
import { OpenClawButton } from './OpenClawButton';
import { SettingsTab } from './SettingsTab';
import { ChangelogTab } from './ChangelogTab';
import { ChannelPairingStep } from './ChannelPairingStep';
import { ChannelSelectionStepView } from './ChannelSelectionStep';
import { PermissionStep } from './PermissionStep';
import { ProvisioningStep } from './ProvisioningStep';
import type { ExecPreset } from './claw.types';
import { BillingWrapper } from './billing/BillingWrapper';

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
}: {
  status: KiloClawDashboardStatus | undefined;
  isNewSetup: boolean;
  onNewSetupChange: (v: boolean) => void;
}) {
  const mutations = useKiloClawMutations();
  const gatewayUrl = useGatewayUrl(status);
  const instanceStatus = hasPopulatedStatus(status) ? status : null;
  const isRunning = instanceStatus?.status === 'running';
  const {
    data: gatewayStatus,
    isLoading: gatewayLoading,
    error: gatewayError,
  } = useKiloClawGatewayStatus(isRunning);

  const { data: isServiceDegraded } = useKiloClawServiceDegraded();

  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
  const instanceYoung =
    instanceStatus !== null &&
    instanceStatus.provisionedAt !== null &&
    Date.now() - instanceStatus.provisionedAt < SEVEN_DAYS_MS;
  const configServiceNudgeVisible = !instanceStatus || instanceYoung;

  const [onboardingStep, setOnboardingStep] = useState<
    'permissions' | 'channels' | 'provisioning' | 'pairing' | 'done'
  >('permissions');
  const [selectedPreset, setSelectedPreset] = useState<ExecPreset | null>(null);
  const [channelTokens, setChannelTokens] = useState<Record<string, string> | null>(null);
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);
  const hasPairingStep = selectedChannelId === 'telegram' || selectedChannelId === 'discord';

  const [dirtySecrets, setDirtySecrets] = useState<Set<string>>(new Set());

  const onSecretsChanged = useCallback((entryId: string) => {
    setDirtySecrets(prev => new Set([...prev, entryId]));
  }, []);
  const [upgradeRequested, setUpgradeRequested] = useState(false);
  const onRequestUpgrade = useCallback(() => setUpgradeRequested(true), []);
  const onUpgradeHandled = useCallback(() => setUpgradeRequested(false), []);

  const onRedeploySuccess = useCallback(() => {
    setDirtySecrets(new Set());
  }, []);

  const onRedeploy = useCallback(() => {
    mutations.restartMachine.mutate(undefined, {
      onSuccess: () => {
        toast.success('Redeploying');
        onRedeploySuccess();
      },
      onError: err => {
        toast.error(err.message, { duration: 10000 });
      },
    });
  }, [mutations.restartMachine, onRedeploySuccess]);

  const onUpgrade = useCallback(() => {
    mutations.restartMachine.mutate(
      { imageTag: 'latest' },
      {
        onSuccess: () => {
          toast.success('Upgrading to latest image');
          onRedeploySuccess();
        },
        onError: err => {
          toast.error(err.message, { duration: 10000 });
        },
      }
    );
  }, [mutations.restartMachine, onRedeploySuccess]);

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

      {configServiceNudgeVisible && !isNewSetup && (
        <div className="border-brand-primary/30 bg-brand-primary/5 flex flex-col gap-3 rounded-xl border p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <Zap className="text-brand-primary mt-0.5 h-5 w-5 shrink-0" />
            <div>
              <p className="text-brand-primary text-sm font-semibold">
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
            className="bg-brand-primary text-primary-foreground hover:bg-brand-primary/90 inline-flex shrink-0 items-center justify-center rounded-md px-4 py-2 text-sm font-medium transition-colors"
          >
            Book your session
          </a>
        </div>
      )}

      <BillingWrapper hideBanners={isNewSetup}>
        {!instanceStatus ? (
          <CreateInstanceCard
            mutations={mutations}
            onProvisionStart={() => onNewSetupChange(true)}
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
            instanceRunning={isRunning && gatewayStatus?.state === 'running'}
            mutations={mutations}
            totalSteps={hasPairingStep ? 5 : 4}
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
                <OpenClawButton
                  canShow={gatewayStatus?.state === 'running'}
                  gatewayUrl={gatewayUrl}
                  look="hero"
                  label="Open KiloClaw"
                  className="w-full py-6 text-base"
                />
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
            <Tabs defaultValue="instance">
              <div className="px-5">
                <TabsList className="mt-4 h-auto w-full justify-start gap-2 rounded-none border-b bg-transparent p-0 pb-3">
                  <TabsTrigger value="instance" className={tabTriggerClass}>
                    Gateway Process
                  </TabsTrigger>
                  <TabsTrigger value="settings" className={tabTriggerClass}>
                    Settings
                  </TabsTrigger>
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
                <TabsContent value="settings" className="mt-0">
                  <SettingsTab
                    status={instanceStatus}
                    mutations={mutations}
                    onSecretsChanged={onSecretsChanged}
                    dirtySecrets={dirtySecrets}
                    onRedeploy={onRedeploy}
                    onUpgrade={onUpgrade}
                    onRequestUpgrade={onRequestUpgrade}
                  />
                </TabsContent>
                <TabsContent value="changelog" className="mt-0">
                  <ChangelogTab />
                </TabsContent>
              </CardContent>
            </Tabs>
          </Card>
        )}
      </BillingWrapper>
    </div>
  );
}
