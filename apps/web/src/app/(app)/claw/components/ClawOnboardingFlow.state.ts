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

export const CLAW_ONBOARDING_WIZARD_STEPS = [
  'identity',
  'permissions',
  'channels',
  'provisioning',
  'pairing',
] as const satisfies OnboardingStep[];

export type ClawOnboardingWizardStep = (typeof CLAW_ONBOARDING_WIZARD_STEPS)[number];

export type ClawOnboardingRenderStep =
  | 'identity'
  | 'permissions'
  | 'channels'
  | 'provisioning'
  | 'pairing'
  | 'complete'
  | 'error';

export type PairingChannelId = 'telegram' | 'discord';

export const FAKE_ONBOARDING_STEP_PARAM = 'fakeOnboardingStep';

export const CLAW_ONBOARDING_FAKE_STEPS = [
  'identity',
  'permissions',
  'channels',
  'provisioning',
  'pairing',
  'complete',
  'error',
] satisfies ClawOnboardingRenderStep[];

export const CLAW_ONBOARDING_PROVISIONING_STATUSES = [
  'provisioned',
  'starting',
  'restarting',
  'recovering',
  'destroying',
  'restoring',
] satisfies PopulatedClawStatus['status'][];

export const CLAW_ONBOARDING_ERROR_STATUSES = ['stopped'] satisfies PopulatedClawStatus['status'][];

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
  setupFailed?: boolean;
  onboardingStep: OnboardingStep;
  selectedPreset: ExecPreset | null;
  hasBotIdentity: boolean;
  selectedChannelId: string | null;
  gatewayState?: GatewayProcessStatusResponse['state'] | null;
  debugLogSource?: string;
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
  currentStep: number;
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

export function isClawOnboardingErrorStatus(status: PopulatedClawStatus['status']): boolean {
  for (const errorStatus of CLAW_ONBOARDING_ERROR_STATUSES) {
    if (status === errorStatus) return true;
  }
  return false;
}

export function getClawOnboardingStepProgress(
  step: OnboardingStep,
  hasPairingStep: boolean
): { currentStep: number; totalSteps: number } {
  const totalSteps = hasPairingStep
    ? CLAW_ONBOARDING_WIZARD_STEPS.length
    : CLAW_ONBOARDING_WIZARD_STEPS.length - 1;

  if (step === 'done') {
    return { currentStep: totalSteps, totalSteps };
  }

  const index = CLAW_ONBOARDING_WIZARD_STEPS.indexOf(step);
  const currentStep = index === -1 ? 0 : index + 1;

  return { currentStep, totalSteps };
}

export function getClawOnboardingFlowState({
  status,
  mode,
  createSetupStarted,
  setupFailed = false,
  onboardingStep,
  selectedPreset,
  hasBotIdentity,
  selectedChannelId,
  gatewayState,
  debugLogSource = 'default',
}: ClawOnboardingFlowStateInput): ClawOnboardingFlowState {
  const instanceStatus = hasPopulatedStatus(status) ? status : null;
  const isRunning = instanceStatus?.status === 'running';
  const gatewayReady = gatewayState === 'running';
  const instanceRunning = isRunning && gatewayReady;
  const postProvisioningReady = isRunning;
  const createSetupActive =
    mode === 'create-first' && (createSetupStarted || instanceStatus !== null);
  const hasPairingStep = isPairingChannel(selectedChannelId);
  const { currentStep, totalSteps } = getClawOnboardingStepProgress(onboardingStep, hasPairingStep);
  const renderStepDecision = getRenderStepDecision({
    mode,
    createSetupStarted,
    setupFailed,
    instanceStatus,
    postProvisioningReady,
    onboardingStep,
    selectedPreset,
    hasBotIdentity,
    hasPairingStep,
  });
  const flowState = {
    renderStep: renderStepDecision.renderStep,
    instanceStatus,
    isRunning,
    gatewayReady,
    instanceRunning,
    createSetupActive,
    postProvisioningReady,
    hasPairingStep,
    currentStep,
    totalSteps,
  } satisfies ClawOnboardingFlowState;

  logClawOnboardingFlowStateDecision({
    status,
    mode,
    createSetupStarted,
    setupFailed,
    onboardingStep,
    selectedPreset,
    hasBotIdentity,
    selectedChannelId,
    gatewayState,
    debugLogSource,
    instanceStatus,
    isRunning,
    gatewayReady,
    instanceRunning,
    createSetupActive,
    postProvisioningReady,
    hasPairingStep,
    currentStep,
    totalSteps,
    renderStepDecision,
  });

  return flowState;
}

type RenderStepInput = Pick<
  ClawOnboardingFlowStateInput,
  | 'mode'
  | 'createSetupStarted'
  | 'setupFailed'
  | 'onboardingStep'
  | 'selectedPreset'
  | 'hasBotIdentity'
> & {
  instanceStatus: PopulatedClawStatus | null;
  postProvisioningReady: boolean;
  hasPairingStep: boolean;
};

type RenderStepDecision = {
  renderStep: ClawOnboardingRenderStep;
  reason: string;
};

type ClawOnboardingFlowDebugLogInput = ClawOnboardingFlowStateInput & {
  debugLogSource: string;
  instanceStatus: PopulatedClawStatus | null;
  isRunning: boolean;
  gatewayReady: boolean;
  instanceRunning: boolean;
  createSetupActive: boolean;
  postProvisioningReady: boolean;
  hasPairingStep: boolean;
  currentStep: number;
  totalSteps: number;
  renderStepDecision: RenderStepDecision;
};

type ClawOnboardingFlowDebugSnapshot = {
  input: string;
  derived: string;
  decision: string;
  loggedAtMs: number;
};

const clawOnboardingFlowDebugSnapshots = new Map<string, ClawOnboardingFlowDebugSnapshot>();

function getRenderStepDecision({
  mode,
  createSetupStarted,
  setupFailed,
  instanceStatus,
  postProvisioningReady,
  onboardingStep,
  selectedPreset,
  hasBotIdentity,
  hasPairingStep,
}: RenderStepInput): RenderStepDecision {
  if (instanceStatus && isClawOnboardingErrorStatus(instanceStatus.status)) {
    return {
      renderStep: 'error',
      reason: `instance status is ${instanceStatus.status}, so setup cannot continue automatically`,
    };
  }

  if (setupFailed && !postProvisioningReady) {
    return {
      renderStep: 'error',
      reason: 'the setup request failed, so setup cannot continue automatically',
    };
  }

  if (mode === 'post-provisioning') {
    if (postProvisioningReady) {
      return {
        renderStep: 'complete',
        reason: 'post-provisioning mode is ready because the instance status is running',
      };
    }
    return {
      renderStep: 'provisioning',
      reason: 'post-provisioning mode is waiting for the instance to become ready',
    };
  }

  if (instanceStatus === null && !createSetupStarted) {
    return {
      renderStep: 'identity',
      reason: 'create-first mode starts with bot identity before setup is requested',
    };
  }

  if (onboardingStep === 'done') {
    return {
      renderStep: 'complete',
      reason: 'stored onboarding step is done',
    };
  }

  if (onboardingStep === 'identity' || !hasBotIdentity) {
    return {
      renderStep: 'identity',
      reason: !hasBotIdentity
        ? 'bot identity is missing, so identity is the earliest safe step'
        : 'stored onboarding step is identity',
    };
  }

  if (onboardingStep === 'permissions' || selectedPreset === null) {
    return {
      renderStep: 'permissions',
      reason:
        selectedPreset === null
          ? 'exec preset is missing, so permissions is the earliest safe step'
          : 'stored onboarding step is permissions',
    };
  }

  if (onboardingStep === 'channels') {
    return {
      renderStep: 'channels',
      reason: 'stored onboarding step is channels',
    };
  }

  if (onboardingStep === 'provisioning') {
    return {
      renderStep: 'provisioning',
      reason: 'stored onboarding step is provisioning',
    };
  }

  if (onboardingStep === 'pairing' && hasPairingStep) {
    return {
      renderStep: 'pairing',
      reason: 'stored onboarding step is pairing and the selected channel requires pairing',
    };
  }

  return {
    renderStep: 'complete',
    reason: 'no earlier step matched, so the flow falls through to complete',
  };
}

function logClawOnboardingFlowStateDecision({
  status,
  mode,
  createSetupStarted,
  setupFailed,
  onboardingStep,
  selectedPreset,
  hasBotIdentity,
  selectedChannelId,
  gatewayState,
  debugLogSource,
  instanceStatus,
  isRunning,
  gatewayReady,
  instanceRunning,
  createSetupActive,
  postProvisioningReady,
  hasPairingStep,
  currentStep,
  totalSteps,
  renderStepDecision,
}: ClawOnboardingFlowDebugLogInput): void {
  if (typeof window === 'undefined') return;

  const input = JSON.stringify(
    {
      mode,
      createSetupStarted,
      setupFailed,
      onboardingStep,
      selectedPreset,
      hasBotIdentity,
      selectedChannelId,
      gatewayState: gatewayState ?? null,
      status: status?.status ?? null,
      hasStatusResponse: status !== undefined,
    },
    null,
    2
  );
  const derived = JSON.stringify(
    {
      instanceStatus: instanceStatus?.status ?? null,
      isRunning,
      gatewayReady,
      instanceRunning,
      createSetupActive,
      postProvisioningReady,
      hasPairingStep,
      currentStep,
      totalSteps,
    },
    null,
    2
  );
  const decision = JSON.stringify(renderStepDecision, null, 2);
  const previousSnapshot = clawOnboardingFlowDebugSnapshots.get(debugLogSource);
  const inputChanged = previousSnapshot?.input !== input;
  const derivedChanged = previousSnapshot?.derived !== derived;
  const decisionChanged = previousSnapshot?.decision !== decision;

  if (!inputChanged && !derivedChanged && !decisionChanged) return;

  const loggedAtMs = window.performance.now();
  const elapsedMs =
    previousSnapshot === undefined ? null : loggedAtMs - previousSnapshot.loggedAtMs;
  const changedSections =
    previousSnapshot === undefined
      ? 'initial'
      : [
          inputChanged ? 'input' : '',
          derivedChanged ? 'derived' : '',
          decisionChanged ? 'decision' : '',
        ]
          .filter(section => section !== '')
          .join(', ');

  clawOnboardingFlowDebugSnapshots.set(debugLogSource, {
    input,
    derived,
    decision,
    loggedAtMs,
  });

  console.debug(
    `[ClawOnboardingFlow:${debugLogSource}] state decision at ${new Date().toISOString()} (${elapsedMs === null ? 'first log' : `+${elapsedMs.toFixed(1)}ms`}; changed: ${changedSections})\ninput:\n${input}\nderived:\n${derived}\ndecision:\n${decision}`
  );
}
