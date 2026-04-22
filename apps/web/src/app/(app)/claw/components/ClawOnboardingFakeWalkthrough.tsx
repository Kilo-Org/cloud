'use client';

import { useEffect, useState } from 'react';
import { TriangleAlert } from 'lucide-react';
import type { PopulatedClawStatus } from './ClawOnboardingFlow.state';
import {
  CLAW_ONBOARDING_FAKE_STEPS,
  type ClawOnboardingRenderStep,
  getClawOnboardingStepProgress,
  isPairingChannel,
  type OnboardingStep,
  type PairingChannelId,
} from './ClawOnboardingFlow.state';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { BotIdentityStep } from './BotIdentityStep';
import { ChannelPairingStepView } from './ChannelPairingStep';
import { ChannelSelectionStepView } from './ChannelSelectionStep';
import { ClawConfigServiceBanner } from './ClawConfigServiceBanner';
import { ClawHeader } from './ClawHeader';
import { ClawSetupCompleteStep, ClawSetupErrorStep } from './ClawOnboardingFlow';
import { PermissionStep } from './PermissionStep';
import { ProvisioningStepView } from './ProvisioningStep';

const FAKE_STEP_LABELS: Record<ClawOnboardingRenderStep, string> = {
  identity: 'Identity',
  permissions: 'Permissions',
  channels: 'Channels',
  provisioning: 'Provisioning',
  pairing: 'Pairing',
  complete: 'Complete',
  error: 'Error',
};

const fakeStatus = {
  userId: 'fake-user',
  sandboxId: 'fake-sandbox',
  provider: 'fly',
  runtimeId: 'fake-machine',
  storageId: 'fake-volume',
  region: 'iad',
  status: 'running',
  provisionedAt: 1,
  lastStartedAt: 2,
  lastStoppedAt: null,
  envVarCount: 0,
  secretCount: 0,
  channelCount: 0,
  flyAppName: 'fake-kiloclaw',
  flyMachineId: 'fake-machine',
  flyVolumeId: 'fake-volume',
  flyRegion: 'iad',
  machineSize: null,
  openclawVersion: 'fake',
  imageVariant: null,
  trackedImageTag: null,
  trackedImageDigest: null,
  googleConnected: false,
  googleOAuthConnected: false,
  googleOAuthStatus: 'disconnected',
  googleOAuthAccountEmail: null,
  googleOAuthCapabilities: [],
  gmailNotificationsEnabled: false,
  execSecurity: 'allowlist',
  execAsk: 'on-miss',
  botName: 'KiloClaw',
  botNature: 'AI assistant',
  botVibe: 'Helpful, capable, professional',
  botEmoji: '🤖',
  workerUrl: 'https://claw.kilo.ai',
  name: 'Fake KiloClaw',
  instanceId: 'fake-instance',
  inboundEmailAddress: null,
  inboundEmailEnabled: false,
} satisfies PopulatedClawStatus;

export function ClawOnboardingFakeWalkthrough({
  initialStep,
  basePath,
}: {
  initialStep: ClawOnboardingRenderStep;
  basePath: string;
}) {
  const [step, setStep] = useState<ClawOnboardingRenderStep>(initialStep);
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>('telegram');

  useEffect(() => {
    setStep(initialStep);
  }, [initialStep]);

  if (process.env.NODE_ENV === 'production') return null;

  const pairingChannelId: PairingChannelId = isPairingChannel(selectedChannelId)
    ? selectedChannelId
    : 'telegram';
  const hasPairingStep = isPairingChannel(selectedChannelId);
  const stepProgress = getFakeStepProgress(step, hasPairingStep);

  return (
    <div className="container m-auto flex w-full max-w-[1140px] flex-col gap-6 p-4 md:p-6">
      <ClawHeader
        status={fakeStatus.status}
        sandboxId={fakeStatus.sandboxId}
        region={fakeStatus.flyRegion}
        gatewayUrl={fakeStatus.workerUrl}
        gatewayReady
        isSetupWizard
      />

      <Alert variant="warning">
        <TriangleAlert className="size-4" />
        <AlertDescription>
          Development-only fake KiloClaw onboarding. This walkthrough does not call billing,
          provisioning, gateway, Fly, or pairing services.
        </AlertDescription>
      </Alert>

      <ClawConfigServiceBanner status={fakeStatus} />
      <FakeWalkthroughControls currentStep={step} onStepChange={setStep} />
      {renderFakeStep({
        step,
        setStep,
        selectedChannelId,
        setSelectedChannelId,
        pairingChannelId,
        stepProgress,
        basePath,
      })}
    </div>
  );
}

type FakeWalkthroughControlsProps = {
  currentStep: ClawOnboardingRenderStep;
  onStepChange: (step: ClawOnboardingRenderStep) => void;
};

function FakeWalkthroughControls({ currentStep, onStepChange }: FakeWalkthroughControlsProps) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-3 p-4">
        <div>
          <p className="text-sm font-semibold">Fake walkthrough controls</p>
          <p className="text-muted-foreground text-xs">
            Jump to any onboarding screen without waiting for external dependencies.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {CLAW_ONBOARDING_FAKE_STEPS.map(step => (
            <Button
              key={step}
              type="button"
              variant={currentStep === step ? 'default' : 'outline'}
              size="sm"
              aria-pressed={currentStep === step}
              onClick={() => onStepChange(step)}
            >
              {FAKE_STEP_LABELS[step]}
            </Button>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

type StepProgress = ReturnType<typeof getClawOnboardingStepProgress>;

type RenderFakeStepInput = {
  step: ClawOnboardingRenderStep;
  setStep: (step: ClawOnboardingRenderStep) => void;
  selectedChannelId: string | null;
  setSelectedChannelId: (channelId: string | null) => void;
  pairingChannelId: PairingChannelId;
  stepProgress: StepProgress;
  basePath: string;
};

function getFakeStepProgress(
  step: ClawOnboardingRenderStep,
  hasPairingStep: boolean
): StepProgress {
  return getClawOnboardingStepProgress(getFakeOnboardingStep(step), hasPairingStep);
}

function getFakeOnboardingStep(step: ClawOnboardingRenderStep): OnboardingStep {
  switch (step) {
    case 'identity':
    case 'permissions':
    case 'channels':
    case 'provisioning':
    case 'pairing':
      return step;
    case 'complete':
    case 'error':
      return 'done';
  }
}

function renderFakeStep({
  step,
  setStep,
  selectedChannelId,
  setSelectedChannelId,
  pairingChannelId,
  stepProgress,
  basePath,
}: RenderFakeStepInput) {
  switch (step) {
    case 'identity': {
      return <BotIdentityStep {...stepProgress} onContinue={() => setStep('permissions')} />;
    }
    case 'permissions': {
      return (
        <PermissionStep
          {...stepProgress}
          instanceRunning={false}
          onSelect={() => setStep('channels')}
        />
      );
    }
    case 'channels': {
      return (
        <ChannelSelectionStepView
          {...stepProgress}
          instanceRunning={false}
          defaultSelected={isPairingChannel(selectedChannelId) ? selectedChannelId : null}
          onSelect={channelId => {
            setSelectedChannelId(channelId);
            setStep('provisioning');
          }}
          onSkip={() => {
            setSelectedChannelId(null);
            setStep('provisioning');
          }}
        />
      );
    }
    case 'provisioning': {
      return (
        <div className="flex flex-col gap-4">
          <ProvisioningStepView {...stepProgress} />
          <Card>
            <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-muted-foreground text-sm">
                Fake mode keeps this spinner static so you can inspect the final provisioning state.
              </p>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() =>
                    setStep(isPairingChannel(selectedChannelId) ? 'pairing' : 'complete')
                  }
                >
                  Continue
                </Button>
                <Button type="button" onClick={() => setStep('complete')}>
                  Complete setup
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      );
    }
    case 'pairing': {
      return (
        <ChannelPairingStepView
          {...stepProgress}
          channelId={pairingChannelId}
          matchingRequest={{
            channel: pairingChannelId,
            code: '123456',
            id: `fake-${pairingChannelId}-user`,
          }}
          onApprove={() => setStep('complete')}
          onSkip={() => setStep('complete')}
        />
      );
    }
    case 'complete':
      return <ClawSetupCompleteStep status={fakeStatus} gatewayReady basePath={basePath} />;
    case 'error':
      return <ClawSetupErrorStep basePath={basePath} />;
  }
}
