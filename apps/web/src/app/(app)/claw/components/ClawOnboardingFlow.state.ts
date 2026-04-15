import type { GatewayProcessStatusResponse, KiloClawDashboardStatus } from '@/lib/kiloclaw/types';
import type { ExecPreset } from './claw.types';

export type PopulatedClawStatus = KiloClawDashboardStatus & {
  status: NonNullable<KiloClawDashboardStatus['status']>;
};

export type ClawOnboardingMode = 'create-first' | 'post-provisioning';

export type OnboardingStep =
  | 'identity'
  | 'permissions'
  | 'channels'
  | 'provisioning'
  | 'pairing'
  | 'done';

export type ClawOnboardingRenderStep =
  | 'create-instance'
  | 'identity'
  | 'permissions'
  | 'channels'
  | 'provisioning'
  | 'pairing'
  | 'complete';

export type PairingChannelId = 'telegram' | 'discord';

export const FAKE_ONBOARDING_STEP_PARAM = 'fakeOnboardingStep';

export const CLAW_ONBOARDING_FAKE_STEPS = [
  'create-instance',
  'identity',
  'permissions',
  'channels',
  'provisioning',
  'pairing',
  'complete',
] satisfies ClawOnboardingRenderStep[];

export function parseClawOnboardingFakeStep(value: string | null): ClawOnboardingRenderStep | null {
  for (const step of CLAW_ONBOARDING_FAKE_STEPS) {
    if (value === step) return step;
  }
  return null;
}

export type ClawOnboardingFlowStateInput = {
  status: KiloClawDashboardStatus | undefined;
  mode: ClawOnboardingMode;
  createSetupStarted: boolean;
  onboardingStep: OnboardingStep;
  selectedPreset: ExecPreset | null;
  hasBotIdentity: boolean;
  selectedChannelId: string | null;
  gatewayState?: GatewayProcessStatusResponse['state'] | null;
};

export type ClawOnboardingFlowState = {
  renderStep: ClawOnboardingRenderStep;
  instanceStatus: PopulatedClawStatus | null;
  isRunning: boolean;
  gatewayReady: boolean;
  instanceRunning: boolean;
  createSetupActive: boolean;
  postProvisioningReady: boolean;
  hasPairingStep: boolean;
  totalSteps: number;
};

export function hasPopulatedStatus(
  candidate: KiloClawDashboardStatus | undefined
): candidate is PopulatedClawStatus {
  return candidate !== undefined && candidate.status !== null;
}

export function isPairingChannel(channelId: string | null): channelId is PairingChannelId {
  return channelId === 'telegram' || channelId === 'discord';
}

export function getClawOnboardingFlowState({
  status,
  mode,
  createSetupStarted,
  onboardingStep,
  selectedPreset,
  hasBotIdentity,
  selectedChannelId,
  gatewayState,
}: ClawOnboardingFlowStateInput): ClawOnboardingFlowState {
  const instanceStatus = hasPopulatedStatus(status) ? status : null;
  const isRunning = instanceStatus?.status === 'running';
  const gatewayReady = gatewayState === 'running';
  const instanceRunning = isRunning && gatewayReady;
  const postProvisioningReady = isRunning;
  const createSetupActive =
    mode === 'create-first' && (createSetupStarted || instanceStatus !== null);
  const hasPairingStep = isPairingChannel(selectedChannelId);
  const totalSteps = hasPairingStep ? 6 : 5;

  return {
    renderStep: getRenderStep({
      mode,
      createSetupStarted,
      instanceStatus,
      postProvisioningReady,
      onboardingStep,
      selectedPreset,
      hasBotIdentity,
      hasPairingStep,
    }),
    instanceStatus,
    isRunning,
    gatewayReady,
    instanceRunning,
    createSetupActive,
    postProvisioningReady,
    hasPairingStep,
    totalSteps,
  };
}

type RenderStepInput = Pick<
  ClawOnboardingFlowStateInput,
  'mode' | 'createSetupStarted' | 'onboardingStep' | 'selectedPreset' | 'hasBotIdentity'
> & {
  instanceStatus: PopulatedClawStatus | null;
  postProvisioningReady: boolean;
  hasPairingStep: boolean;
};

function getRenderStep({
  mode,
  createSetupStarted,
  instanceStatus,
  postProvisioningReady,
  onboardingStep,
  selectedPreset,
  hasBotIdentity,
  hasPairingStep,
}: RenderStepInput): ClawOnboardingRenderStep {
  if (mode === 'post-provisioning') {
    if (postProvisioningReady) return 'complete';
    // DB row + subscription exist but no DO provisioned yet (e.g. credit
    // enrollment created the billing records without triggering provision).
    // Show the onboarding entry point so the user can kick off provisioning.
    if (!instanceStatus) return 'create-instance';
    return 'provisioning';
  }

  if (instanceStatus === null && !createSetupStarted) {
    return 'create-instance';
  }

  if (onboardingStep === 'done') {
    return 'complete';
  }

  if (onboardingStep === 'identity' || !hasBotIdentity) {
    return 'identity';
  }

  if (onboardingStep === 'permissions' || selectedPreset === null) {
    return 'permissions';
  }

  if (onboardingStep === 'channels') {
    return 'channels';
  }

  if (onboardingStep === 'provisioning') {
    return 'provisioning';
  }

  if (onboardingStep === 'pairing' && hasPairingStep) {
    return 'pairing';
  }

  return 'complete';
}
