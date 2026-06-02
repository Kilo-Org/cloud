import type { GatewayProcessStatusOkResponse, KiloClawDashboardStatus } from '@/lib/kiloclaw/types';

export type PopulatedClawStatus = KiloClawDashboardStatus & {
  status: NonNullable<KiloClawDashboardStatus['status']>;
};

export type ClawOnboardingMode = 'create-first' | 'post-provisioning';

export type OnboardingStep =
  | 'identity'
  | 'calendar'
  | 'email'
  | 'interests'
  | 'provisioning'
  | 'done';

export const CLAW_ONBOARDING_WIZARD_STEPS = [
  'identity',
  'calendar',
  'email',
  'interests',
  'provisioning',
] as const satisfies OnboardingStep[];

export type ClawOnboardingWizardStep = (typeof CLAW_ONBOARDING_WIZARD_STEPS)[number];

export type ClawOnboardingRenderStep =
  | 'identity'
  | 'calendar'
  | 'email'
  | 'interests'
  | 'provisioning'
  | 'complete'
  | 'error';

// Kept for parity with `ChannelPairingStep.tsx`, which currently isn't wired
// into the wizard but stays in the codebase in case channel pairing comes
// back. Not used in the active onboarding flow.
export type PairingChannelId = 'telegram' | 'discord';

export const FAKE_ONBOARDING_STEP_PARAM = 'fakeOnboardingStep';

export const CLAW_ONBOARDING_FAKE_STEPS = [
  'identity',
  'calendar',
  'email',
  'interests',
  'provisioning',
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
  hasBotIdentity: boolean;
  gatewayState?: GatewayProcessStatusOkResponse['state'] | null;
  /**
   * Whether the calendar step is available in the wizard. When false, the
   * wizard advances identity -> email and `'calendar'` is mapped to `'email'`
   * in the render decision.
   */
  hasCalendarStep?: boolean;
  /**
   * Whether the morning-briefing Interests step is available in the wizard.
   * Morning briefing is generally available; this is gated on controller
   * version only (`controllerSupportsInterests` in `ClawOnboardingFlow.tsx`).
   * When false, `'interests'` is mapped to `'provisioning'` in the render
   * decision.
   */
  hasInterestsStep?: boolean;
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
  hasCalendarStep: boolean;
  hasInterestsStep: boolean;
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

function getActiveWizardSteps(
  hasCalendarStep: boolean,
  hasInterestsStep: boolean
): OnboardingStep[] {
  const steps: OnboardingStep[] = ['identity'];
  if (hasCalendarStep) steps.push('calendar');
  steps.push('email');
  if (hasInterestsStep) steps.push('interests');
  steps.push('provisioning');
  return steps;
}

export function getClawOnboardingStepProgress(
  step: OnboardingStep,
  hasCalendarStep: boolean = true,
  hasInterestsStep: boolean = true
): { currentStep: number; totalSteps: number } {
  const wizardSteps = getActiveWizardSteps(hasCalendarStep, hasInterestsStep);
  const totalSteps = wizardSteps.length;

  if (step === 'done') {
    return { currentStep: totalSteps, totalSteps };
  }

  // A user sitting briefly on an unavailable step gets normalized to the
  // next available step for progress display, matching the render decision.
  let lookupStep: OnboardingStep = step;
  if (lookupStep === 'calendar' && !hasCalendarStep) lookupStep = 'email';
  if (lookupStep === 'interests' && !hasInterestsStep) lookupStep = 'provisioning';
  const index = wizardSteps.indexOf(lookupStep);
  const currentStep = index === -1 ? 0 : index + 1;

  return { currentStep, totalSteps };
}

export function getClawOnboardingFlowState({
  status,
  mode,
  createSetupStarted,
  setupFailed = false,
  onboardingStep,
  hasBotIdentity,
  gatewayState,
  hasCalendarStep = true,
  hasInterestsStep = true,
  debugLogSource = 'default',
}: ClawOnboardingFlowStateInput): ClawOnboardingFlowState {
  const instanceStatus = hasPopulatedStatus(status) ? status : null;
  const isRunning = instanceStatus?.status === 'running';
  const gatewayReady = gatewayState === 'running';
  const instanceRunning = isRunning && gatewayReady;
  const postProvisioningReady = isRunning;
  const createSetupActive =
    mode === 'create-first' && (createSetupStarted || instanceStatus !== null);
  const { currentStep, totalSteps } = getClawOnboardingStepProgress(
    onboardingStep,
    hasCalendarStep,
    hasInterestsStep
  );
  const renderStepDecision = getRenderStepDecision({
    mode,
    createSetupStarted,
    setupFailed,
    instanceStatus,
    postProvisioningReady,
    onboardingStep,
    hasBotIdentity,
    hasCalendarStep,
    hasInterestsStep,
  });
  const flowState = {
    renderStep: renderStepDecision.renderStep,
    instanceStatus,
    isRunning,
    gatewayReady,
    instanceRunning,
    createSetupActive,
    postProvisioningReady,
    hasCalendarStep,
    hasInterestsStep,
    currentStep,
    totalSteps,
  } satisfies ClawOnboardingFlowState;

  logClawOnboardingFlowStateDecision({
    status,
    mode,
    createSetupStarted,
    setupFailed,
    onboardingStep,
    hasBotIdentity,
    gatewayState,
    hasCalendarStep,
    hasInterestsStep,
    debugLogSource,
    instanceStatus,
    isRunning,
    gatewayReady,
    instanceRunning,
    createSetupActive,
    postProvisioningReady,
    currentStep,
    totalSteps,
    renderStepDecision,
  });

  return flowState;
}

type RenderStepInput = Pick<
  ClawOnboardingFlowStateInput,
  'mode' | 'createSetupStarted' | 'setupFailed' | 'onboardingStep' | 'hasBotIdentity'
> & {
  instanceStatus: PopulatedClawStatus | null;
  postProvisioningReady: boolean;
  hasCalendarStep: boolean;
  hasInterestsStep: boolean;
};

type RenderStepDecision = {
  renderStep: ClawOnboardingRenderStep;
  reason: string;
};

type ClawOnboardingFlowDebugLogInput = ClawOnboardingFlowStateInput & {
  debugLogSource: string;
  hasCalendarStep: boolean;
  hasInterestsStep: boolean;
  instanceStatus: PopulatedClawStatus | null;
  isRunning: boolean;
  gatewayReady: boolean;
  instanceRunning: boolean;
  createSetupActive: boolean;
  postProvisioningReady: boolean;
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
  hasBotIdentity,
  hasCalendarStep,
  hasInterestsStep,
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
    // After a full-page reload (e.g. the Google OAuth round-trip), the
    // wizard often remounts in post-provisioning mode because the instance
    // row is now visible — but the user is still mid-wizard. Honor any
    // explicit wizard step rather than auto-routing them past it.
    if (onboardingStep === 'calendar') {
      if (!hasCalendarStep) {
        return {
          renderStep: 'email',
          reason: 'calendar step is unavailable; advance to email',
        };
      }
      return {
        renderStep: 'calendar',
        reason: 'calendar resume requested; honor it even in post-provisioning mode',
      };
    }
    if (onboardingStep === 'email') {
      return {
        renderStep: 'email',
        reason: 'wizard resume on email; honor it even in post-provisioning mode',
      };
    }
    if (onboardingStep === 'interests') {
      if (!hasInterestsStep) {
        return {
          renderStep: 'provisioning',
          reason: 'interests step is unavailable; advance to provisioning',
        };
      }
      return {
        renderStep: 'interests',
        reason: 'wizard resume on interests; honor it even in post-provisioning mode',
      };
    }
    if (onboardingStep === 'provisioning') {
      return {
        renderStep: 'provisioning',
        reason: 'wizard resume on provisioning; honor it even in post-provisioning mode',
      };
    }
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

  if (
    instanceStatus === null &&
    !createSetupStarted &&
    (onboardingStep === 'identity' || !hasBotIdentity)
  ) {
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

  if (onboardingStep === 'calendar') {
    if (!hasCalendarStep) {
      return {
        renderStep: 'email',
        reason: 'calendar step is unavailable; advance to email',
      };
    }
    return {
      renderStep: 'calendar',
      reason: 'stored onboarding step is calendar',
    };
  }

  if (onboardingStep === 'email') {
    return {
      renderStep: 'email',
      reason: 'stored onboarding step is email',
    };
  }

  if (onboardingStep === 'interests') {
    if (!hasInterestsStep) {
      return {
        renderStep: 'provisioning',
        reason: 'interests step is unavailable; advance to provisioning',
      };
    }
    return {
      renderStep: 'interests',
      reason: 'stored onboarding step is interests',
    };
  }

  if (onboardingStep === 'provisioning') {
    return {
      renderStep: 'provisioning',
      reason: 'stored onboarding step is provisioning',
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
  hasBotIdentity,
  gatewayState,
  hasCalendarStep,
  hasInterestsStep,
  debugLogSource,
  instanceStatus,
  isRunning,
  gatewayReady,
  instanceRunning,
  createSetupActive,
  postProvisioningReady,
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
      hasBotIdentity,
      gatewayState: gatewayState ?? null,
      hasCalendarStep,
      hasInterestsStep,
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
