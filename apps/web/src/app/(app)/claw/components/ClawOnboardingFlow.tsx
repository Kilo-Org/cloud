'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useFeatureFlagVariantKey, usePostHog } from 'posthog-js/react';
import { toast } from 'sonner';
import { Check, Sparkles, TriangleAlert, X } from 'lucide-react';
import { KILO_AUTO_BALANCED_MODEL } from '@/lib/kilo-auto';
import type { KiloClawDashboardStatus } from '@/lib/kiloclaw/types';
import { useKiloClawGatewayStatus, useKiloClawMutations } from '@/hooks/useKiloClaw';
import { useOrgKiloClawGatewayStatus, useOrgKiloClawMutations } from '@/hooks/useOrgKiloClaw';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useClawServiceDegraded } from '../hooks/useClawHooks';
import { useOnboardingSaves } from '../hooks/useOnboardingSaves';
import { useGatewayUrl } from '../hooks/useGatewayUrl';
import { BillingWrapper } from './billing/BillingWrapper';
import { BotIdentityStep } from './BotIdentityStep';
import { ChannelPairingStep } from './ChannelPairingStep';
import { ChannelSelectionStepView } from './ChannelSelectionStep';
import { ClawContextProvider, useClawContext } from './ClawContext';
import { ClawConfigServiceBanner } from './ClawConfigServiceBanner';
import { ClawHeader } from './ClawHeader';
import { ProvisioningStep, ProvisioningStepView } from './ProvisioningStep';
import { DEFAULT_ONBOARDING_EXEC_PRESET } from './claw.types';
import type { BotIdentity, ExecPreset } from './claw.types';
import {
  getClawOnboardingFlowState,
  isPairingChannel,
  type ClawOnboardingMode,
  type OnboardingStep,
  type PopulatedClawStatus,
} from './ClawOnboardingFlow.state';

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

function assertNever(value: never): never {
  throw new Error(`Unhandled KiloClaw onboarding render step: ${value}`);
}

function getBrowserTimeZone(): string | undefined {
  try {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof timeZone === 'string' && timeZone.trim() ? timeZone : undefined;
  } catch {
    return undefined;
  }
}

export type { ClawOnboardingMode };

export function ClawOnboardingFlow({
  status,
  mode,
  organizationId,
  createFlowStarted = false,
  setupFailed = false,
  onCreateFlowStarted,
  onCreateFlowFailed,
}: {
  status: KiloClawDashboardStatus | undefined;
  mode: ClawOnboardingMode;
  organizationId?: string;
  createFlowStarted?: boolean;
  setupFailed?: boolean;
  onCreateFlowStarted?: () => void;
  onCreateFlowFailed?: () => void;
}) {
  return (
    <ClawContextProvider organizationId={organizationId}>
      <ClawOnboardingFlowInner
        status={status}
        mode={mode}
        createFlowStarted={createFlowStarted}
        setupFailed={setupFailed}
        onCreateFlowStarted={onCreateFlowStarted}
        onCreateFlowFailed={onCreateFlowFailed}
      />
    </ClawContextProvider>
  );
}

function ClawOnboardingFlowInner({
  status,
  mode,
  createFlowStarted,
  setupFailed,
  onCreateFlowStarted,
  onCreateFlowFailed,
}: {
  status: KiloClawDashboardStatus | undefined;
  mode: ClawOnboardingMode;
  createFlowStarted: boolean;
  setupFailed: boolean;
  onCreateFlowStarted?: () => void;
  onCreateFlowFailed?: () => void;
}) {
  const { organizationId } = useClawContext();

  const personalMutations = useKiloClawMutations();
  const orgMutations = useOrgKiloClawMutations(organizationId ?? '');
  const mutations = organizationId ? orgMutations : personalMutations;

  const gatewayUrl = useGatewayUrl(status);

  const [onboardingStep, setOnboardingStep] = useState<OnboardingStep>('identity');
  const selectedPreset: ExecPreset = DEFAULT_ONBOARDING_EXEC_PRESET;
  const [botIdentity, setBotIdentity] = useState<BotIdentity | null>(null);
  const [channelTokens, setChannelTokens] = useState<Record<string, string> | null>(null);
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);
  const [localCreateSetupStarted, setLocalCreateSetupStarted] = useState(false);
  const [onboardingSaveSession, setOnboardingSaveSession] = useState(0);
  const hasCapturedIdentityView = useRef(false);
  const hasCapturedDoneView = useRef(false);
  const createSetupStarted = createFlowStarted || localCreateSetupStarted;

  const stateInput = {
    status,
    mode,
    createSetupStarted,
    setupFailed,
    onboardingStep,
    hasBotIdentity: botIdentity !== null,
    selectedChannelId,
  };
  const preGatewayFlowState = getClawOnboardingFlowState({
    ...stateInput,
    gatewayState: null,
    debugLogSource: 'pre-gateway',
  });

  const personalGateway = useKiloClawGatewayStatus(
    !organizationId && preGatewayFlowState.isRunning
  );
  const orgGateway = useOrgKiloClawGatewayStatus(
    organizationId ?? '',
    !!organizationId && preGatewayFlowState.isRunning
  );
  const { data: gatewayStatus } = organizationId ? orgGateway : personalGateway;
  const flowState = getClawOnboardingFlowState({
    ...stateInput,
    gatewayState: gatewayStatus?.state ?? null,
    debugLogSource: 'gateway',
  });

  const { data: isServiceDegraded } = useClawServiceDegraded();
  useFeatureFlagVariantKey('button-vs-card');
  const posthog = usePostHog();

  // Save bot identity, exec preset, and channel tokens as soon as the instance
  // row exists. This closes the tab-close window where customizations entered
  // during the provisioning spinner could otherwise be lost with the unmounted
  // ProvisioningStep.
  const onboardingSaves = useOnboardingSaves({
    hasInstance: flowState.instanceStatus !== null,
    botIdentity,
    selectedPreset,
    channelTokens,
    resetKey: `${onboardingSaveSession}:${
      flowState.instanceStatus?.instanceId ?? flowState.instanceStatus?.sandboxId ?? 'pending'
    }`,
    mutations,
  });

  useEffect(() => {
    if (flowState.renderStep !== 'identity' || hasCapturedIdentityView.current) return;
    hasCapturedIdentityView.current = true;
    posthog?.capture('claw_page_viewed');
    posthog?.capture('claw_setup_identity_viewed');
  }, [flowState.renderStep, posthog]);

  useEffect(() => {
    if (
      mode !== 'post-provisioning' ||
      !flowState.postProvisioningReady ||
      hasCapturedDoneView.current
    ) {
      return;
    }
    hasCapturedDoneView.current = true;
    posthog?.capture('claw_setup_done_viewed');
  }, [mode, flowState.postProvisioningReady, posthog]);

  const resetWizardSelections = useCallback(() => {
    setOnboardingStep('identity');
    setBotIdentity(null);
    setChannelTokens(null);
    setSelectedChannelId(null);
  }, []);

  const handleCreateFlowStarted = useCallback(() => {
    setLocalCreateSetupStarted(true);
    setOnboardingSaveSession(value => value + 1);
    resetWizardSelections();
    onCreateFlowStarted?.();
  }, [onCreateFlowStarted, resetWizardSelections]);

  const handleCreateFlowFailed = useCallback(() => {
    setLocalCreateSetupStarted(false);
    hasCapturedIdentityView.current = false;
    resetWizardSelections();
    onCreateFlowFailed?.();
  }, [onCreateFlowFailed, resetWizardSelections]);

  const basePath = organizationId ? `/organizations/${organizationId}/claw` : '/claw';

  function provisionInstance(userLocation?: string) {
    handleCreateFlowStarted();

    mutations.provision.mutate(
      {
        kilocodeDefaultModel: `kilocode/${KILO_AUTO_BALANCED_MODEL.id}`,
        userTimezone: getBrowserTimeZone(),
        ...(userLocation ? { userLocation } : undefined),
      },
      {
        onError: err => {
          posthog?.capture('claw_setup_provision_failed', {
            selected_model: KILO_AUTO_BALANCED_MODEL.id,
            reason: 'provision_request_failed',
          });
          handleCreateFlowFailed();
          toast.error(`Failed to create: ${err.message}`);
        },
      }
    );
  }

  function renderIdentityStep() {
    return (
      <BotIdentityStep
        currentStep={flowState.currentStep}
        totalSteps={flowState.totalSteps}
        onContinue={({ identity, weatherLocation }) => {
          posthog?.capture('claw_setup_identity_completed', {
            bot_name_is_custom: identity.botName !== 'KiloClaw',
            bot_nature: identity.botNature,
            bot_emoji_is_custom: identity.botEmoji !== '🤖',
          });
          if (weatherLocation) {
            posthog?.capture('claw_weather_location_selected', { source: weatherLocation.source });
          } else {
            posthog?.capture('claw_weather_location_skipped');
          }

          if (flowState.instanceStatus) {
            if (weatherLocation) {
              mutations.updateConfig.mutate(
                { userLocation: weatherLocation.location },
                { onError: err => toast.error(err.message) }
              );
            }
          } else {
            posthog?.capture('claw_create_instance_clicked', {
              selected_model: KILO_AUTO_BALANCED_MODEL.id,
            });
            provisionInstance(weatherLocation?.location);
          }
          posthog?.capture('claw_setup_permissions_completed', {
            preset: DEFAULT_ONBOARDING_EXEC_PRESET,
            defaulted: true,
          });
          posthog?.capture('claw_setup_channels_viewed');
          setBotIdentity(identity);
          setOnboardingStep('channels');
        }}
      />
    );
  }

  function renderChannelsStep() {
    return (
      <ChannelSelectionStepView
        currentStep={flowState.currentStep}
        totalSteps={flowState.totalSteps}
        instanceRunning={flowState.instanceRunning}
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
    );
  }

  function renderProvisioningStep() {
    if (mode === 'post-provisioning')
      return (
        <ProvisioningStepView
          currentStep={flowState.currentStep}
          totalSteps={flowState.totalSteps}
        />
      );

    return (
      <ProvisioningStep
        currentStep={flowState.currentStep}
        totalSteps={flowState.totalSteps}
        onboardingSavesReady={onboardingSaves.ready}
        instanceRunning={flowState.instanceRunning}
        onComplete={() => {
          posthog?.capture('claw_setup_provisioned');
          posthog?.capture(
            flowState.hasPairingStep ? 'claw_setup_pairing_viewed' : 'claw_setup_done_viewed'
          );
          setOnboardingStep(flowState.hasPairingStep ? 'pairing' : 'done');
        }}
      />
    );
  }

  function renderPairingStep() {
    if (!isPairingChannel(selectedChannelId)) return renderCompleteStep();

    return (
      <ChannelPairingStep
        currentStep={flowState.currentStep}
        totalSteps={flowState.totalSteps}
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
    );
  }

  function renderCompleteStep() {
    return (
      <ClawSetupCompleteStep
        status={flowState.instanceStatus}
        gatewayReady={flowState.gatewayReady}
        basePath={basePath}
      />
    );
  }

  function renderErrorStep() {
    return <ClawSetupErrorStep basePath={basePath} />;
  }

  function renderStepContent() {
    const renderStep = flowState.renderStep;

    switch (renderStep) {
      case 'identity':
        return renderIdentityStep();
      case 'channels':
        return renderChannelsStep();
      case 'provisioning':
        return renderProvisioningStep();
      case 'pairing':
        return renderPairingStep();
      case 'complete':
        return renderCompleteStep();
      case 'error':
        return renderErrorStep();
      default:
        return assertNever(renderStep);
    }
  }

  return (
    <div className="container m-auto flex w-full max-w-[1140px] flex-col gap-6 p-4 md:p-6">
      <ClawHeader
        status={status?.status || null}
        sandboxId={status?.sandboxId || null}
        region={status?.flyRegion || null}
        gatewayUrl={gatewayUrl}
        gatewayReady={flowState.gatewayReady}
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
        {renderStepContent()}
      </MaybeBillingWrapper>
    </div>
  );
}

export function ClawSetupErrorStep({ basePath }: { basePath: string }) {
  return (
    <Card className="mt-6 overflow-hidden">
      <CardContent className="flex flex-col items-center justify-center gap-6 pt-12">
        <div className="flex h-20 w-20 items-center justify-center rounded-2xl border border-destructive/30 bg-destructive/10">
          <div className="flex h-12 w-12 items-center justify-center rounded-full border-2 border-destructive">
            <TriangleAlert className="h-6 w-6 text-destructive" />
          </div>
        </div>

        <div className="flex flex-col items-center gap-2">
          <h2 className="text-2xl font-bold">Something went wrong</h2>
          <p className="text-muted-foreground max-w-md text-center">
            Your KiloClaw instance stopped or failed during setup. Please reach out to support for
            help getting it back online.
          </p>
        </div>

        <div className="flex w-full flex-col gap-3">
          <Button asChild variant="primary" className="w-full min-w-[180px] py-6 text-base">
            <a href="https://kilo.ai/support" target="_blank" rel="noopener noreferrer">
              Contact Support
            </a>
          </Button>
          <Button asChild className="w-full py-6 text-base" variant="outline">
            <Link href={basePath}>
              <X className="mr-2 h-4 w-4" />
              Close Wizard
            </Link>
          </Button>
        </div>
      </CardContent>
    </Card>
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
