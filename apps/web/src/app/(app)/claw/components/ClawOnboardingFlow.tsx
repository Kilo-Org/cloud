'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePostHog } from 'posthog-js/react';
import { Check, Sparkles, TriangleAlert, X } from 'lucide-react';
import type { KiloClawDashboardStatus } from '@/lib/kiloclaw/types';
import { useKiloClawGatewayStatus, useKiloClawMutations } from '@/hooks/useKiloClaw';
import { useOrgKiloClawGatewayStatus, useOrgKiloClawMutations } from '@/hooks/useOrgKiloClaw';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useClawServiceDegraded } from '../hooks/useClawHooks';
import { useGatewayUrl } from '../hooks/useGatewayUrl';
import { BillingWrapper } from './billing/BillingWrapper';
import { BotIdentityStep } from './BotIdentityStep';
import { ChannelPairingStep } from './ChannelPairingStep';
import { ChannelSelectionStepView } from './ChannelSelectionStep';
import { ClawContextProvider, useClawContext } from './ClawContext';
import { ClawConfigServiceBanner } from './ClawConfigServiceBanner';
import { ClawHeader } from './ClawHeader';
import { CreateInstanceCard } from './CreateInstanceCard';
import { PermissionStep } from './PermissionStep';
import { ProvisioningStep, ProvisioningStepView } from './ProvisioningStep';
import type { BotIdentity, ExecPreset } from './claw.types';

type PopulatedClawStatus = KiloClawDashboardStatus & {
  status: NonNullable<KiloClawDashboardStatus['status']>;
};

function hasPopulatedStatus(
  candidate: KiloClawDashboardStatus | undefined
): candidate is PopulatedClawStatus {
  return candidate !== undefined && candidate.status !== null;
}

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

export type ClawOnboardingMode = 'create-first' | 'post-provisioning';

type OnboardingStep = 'identity' | 'permissions' | 'channels' | 'provisioning' | 'pairing' | 'done';

export function ClawOnboardingFlow({
  status,
  mode,
  organizationId,
  onCreateFlowStarted,
  onCreateFlowFailed,
}: {
  status: KiloClawDashboardStatus | undefined;
  mode: ClawOnboardingMode;
  organizationId?: string;
  onCreateFlowStarted?: () => void;
  onCreateFlowFailed?: () => void;
}) {
  return (
    <ClawContextProvider organizationId={organizationId}>
      <ClawOnboardingFlowInner
        status={status}
        mode={mode}
        onCreateFlowStarted={onCreateFlowStarted}
        onCreateFlowFailed={onCreateFlowFailed}
      />
    </ClawContextProvider>
  );
}

function ClawOnboardingFlowInner({
  status,
  mode,
  onCreateFlowStarted,
  onCreateFlowFailed,
}: {
  status: KiloClawDashboardStatus | undefined;
  mode: ClawOnboardingMode;
  onCreateFlowStarted?: () => void;
  onCreateFlowFailed?: () => void;
}) {
  const { organizationId } = useClawContext();

  const personalMutations = useKiloClawMutations();
  const orgMutations = useOrgKiloClawMutations(organizationId ?? '');
  const mutations = organizationId ? orgMutations : personalMutations;

  const gatewayUrl = useGatewayUrl(status);
  const instanceStatus = hasPopulatedStatus(status) ? status : null;
  const isRunning = instanceStatus?.status === 'running';
  const postProvisioningReady = isRunning;

  const personalGateway = useKiloClawGatewayStatus(!organizationId && isRunning);
  const orgGateway = useOrgKiloClawGatewayStatus(
    organizationId ?? '',
    !!organizationId && isRunning
  );
  const { data: gatewayStatus } = organizationId ? orgGateway : personalGateway;
  const instanceRunning = isRunning && gatewayStatus?.state === 'running';

  const { data: isServiceDegraded } = useClawServiceDegraded();
  const posthog = usePostHog();

  const [onboardingStep, setOnboardingStep] = useState<OnboardingStep>('identity');
  const [selectedPreset, setSelectedPreset] = useState<ExecPreset | null>(null);
  const [botIdentity, setBotIdentity] = useState<BotIdentity | null>(null);
  const [channelTokens, setChannelTokens] = useState<Record<string, string> | null>(null);
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);
  const [createSetupStarted, setCreateSetupStarted] = useState(false);
  const hasPairingStep = selectedChannelId === 'telegram' || selectedChannelId === 'discord';
  const hasCapturedIdentityView = useRef(false);
  const hasCapturedDoneView = useRef(false);

  const createSetupActive =
    mode === 'create-first' && (createSetupStarted || instanceStatus !== null);

  useEffect(() => {
    if (!createSetupActive || hasCapturedIdentityView.current) return;
    hasCapturedIdentityView.current = true;
    posthog?.capture('claw_setup_identity_viewed');
  }, [createSetupActive, posthog]);

  useEffect(() => {
    if (mode !== 'post-provisioning' || !postProvisioningReady || hasCapturedDoneView.current) {
      return;
    }
    hasCapturedDoneView.current = true;
    posthog?.capture('claw_setup_done_viewed');
  }, [mode, postProvisioningReady, posthog]);

  const resetWizardSelections = useCallback(() => {
    setOnboardingStep('identity');
    setSelectedPreset(null);
    setBotIdentity(null);
    setChannelTokens(null);
    setSelectedChannelId(null);
  }, []);

  const handleCreateFlowStarted = useCallback(() => {
    setCreateSetupStarted(true);
    resetWizardSelections();
    onCreateFlowStarted?.();
  }, [onCreateFlowStarted, resetWizardSelections]);

  const handleCreateFlowFailed = useCallback(() => {
    setCreateSetupStarted(false);
    hasCapturedIdentityView.current = false;
    resetWizardSelections();
    onCreateFlowFailed?.();
  }, [onCreateFlowFailed, resetWizardSelections]);

  const basePath = organizationId ? `/organizations/${organizationId}/claw` : '/claw';

  return (
    <div className="container m-auto flex w-full max-w-[1140px] flex-col gap-6 p-4 md:p-6">
      <ClawHeader
        status={status?.status || null}
        sandboxId={status?.sandboxId || null}
        region={status?.flyRegion || null}
        gatewayUrl={gatewayUrl}
        gatewayReady={gatewayStatus?.state === 'running'}
        isSetupWizard
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

      <ClawConfigServiceBanner status={status} />

      <MaybeBillingWrapper skip={!!organizationId} hideBanners>
        {mode === 'post-provisioning' ? (
          postProvisioningReady ? (
            <ClawSetupCompleteStep
              status={instanceStatus}
              gatewayReady={gatewayStatus?.state === 'running'}
              basePath={basePath}
            />
          ) : (
            <ProvisioningStepView />
          )
        ) : !instanceStatus && !createSetupStarted ? (
          <CreateInstanceCard
            mutations={mutations}
            onProvisionStart={handleCreateFlowStarted}
            onProvisionFailed={handleCreateFlowFailed}
          />
        ) : onboardingStep === 'identity' ? (
          <BotIdentityStep
            instanceRunning={instanceRunning}
            onContinue={identity => {
              posthog?.capture('claw_setup_identity_completed', {
                bot_name_is_custom: identity.botName !== 'KiloClaw',
                bot_nature: identity.botNature,
                bot_emoji_is_custom: identity.botEmoji !== '🤖',
              });
              posthog?.capture('claw_setup_permissions_viewed');
              setBotIdentity(identity);
              setOnboardingStep('permissions');
            }}
          />
        ) : onboardingStep === 'permissions' ? (
          <PermissionStep
            instanceRunning={instanceRunning}
            onSelect={preset => {
              posthog?.capture('claw_setup_permissions_completed', { preset });
              posthog?.capture('claw_setup_channels_viewed');
              setSelectedPreset(preset);
              setOnboardingStep('channels');
            }}
          />
        ) : onboardingStep === 'channels' ? (
          <ChannelSelectionStepView
            instanceRunning={instanceRunning}
            onSelect={(channelId, tokens) => {
              posthog?.capture('claw_setup_channels_completed', {
                channel: channelId,
                skipped: false,
              });
              posthog?.capture('claw_setup_provisioning_viewed');
              setSelectedChannelId(channelId);
              setChannelTokens(tokens);
              setOnboardingStep('provisioning');
            }}
            onSkip={() => {
              posthog?.capture('claw_setup_channels_completed', {
                channel: null,
                skipped: true,
              });
              posthog?.capture('claw_setup_provisioning_viewed');
              setSelectedChannelId(null);
              setChannelTokens(null);
              setOnboardingStep('provisioning');
            }}
          />
        ) : onboardingStep === 'provisioning' && selectedPreset ? (
          <ProvisioningStep
            preset={selectedPreset}
            channelTokens={channelTokens}
            botIdentity={botIdentity}
            instanceRunning={instanceRunning}
            mutations={mutations}
            totalSteps={hasPairingStep ? 6 : 5}
            onComplete={() => {
              posthog?.capture('claw_setup_provisioned');
              posthog?.capture(
                hasPairingStep ? 'claw_setup_pairing_viewed' : 'claw_setup_done_viewed'
              );
              setOnboardingStep(hasPairingStep ? 'pairing' : 'done');
            }}
          />
        ) : onboardingStep === 'pairing' &&
          (selectedChannelId === 'telegram' || selectedChannelId === 'discord') ? (
          <ChannelPairingStep
            channelId={selectedChannelId}
            mutations={mutations}
            onComplete={() => {
              posthog?.capture('claw_setup_pairing_completed', {
                channel: selectedChannelId,
                skipped: false,
              });
              posthog?.capture('claw_setup_done_viewed');
              setOnboardingStep('done');
            }}
            onSkip={() => {
              posthog?.capture('claw_setup_pairing_completed', {
                channel: selectedChannelId,
                skipped: true,
              });
              posthog?.capture('claw_setup_done_viewed');
              setOnboardingStep('done');
            }}
          />
        ) : (
          <ClawSetupCompleteStep
            status={instanceStatus}
            gatewayReady={gatewayStatus?.state === 'running'}
            basePath={basePath}
          />
        )}
      </MaybeBillingWrapper>
    </div>
  );
}

export function ClawSetupCompleteStep({
  status,
  gatewayReady,
  basePath,
}: {
  status: PopulatedClawStatus | null;
  gatewayReady: boolean;
  basePath: string;
}) {
  const posthog = usePostHog();

  return (
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
            KiloClaw has been provisioned and configured with your settings. You&apos;re all set to
            start.
          </p>
        </div>

        {status?.flyRegion && (
          <div className="border-border/50 flex items-center gap-2 rounded-full border px-4 py-2">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
            </span>
            <span className="text-muted-foreground flex items-center gap-2 text-sm">
              Active ·{' '}
              <span className="text-foreground font-bold">{status.flyRegion.toUpperCase()}</span>{' '}
              region
            </span>
          </div>
        )}
        <div className="flex w-full flex-col gap-3">
          {gatewayReady && (
            <Button
              asChild
              variant="primary"
              className="w-full min-w-[180px] bg-emerald-600 py-6 text-base text-white hover:bg-emerald-700"
              onClick={() => posthog?.capture('claw_setup_open_chat_clicked')}
            >
              <Link href={`${basePath}/chat`}>Open KiloClaw</Link>
            </Button>
          )}
          <Button asChild className="w-full py-6 text-base" variant="outline">
            <Link
              href={basePath}
              onClick={() => posthog?.capture('claw_setup_close_wizard_clicked')}
            >
              <X className="mr-2 h-4 w-4" />
              Close Wizard
            </Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
