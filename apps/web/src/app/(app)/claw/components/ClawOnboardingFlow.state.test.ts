import { describe, expect, test } from '@jest/globals';
import type { KiloClawDashboardStatus } from '@/lib/kiloclaw/types';
import {
  CLAW_ONBOARDING_ERROR_STATUSES,
  CLAW_ONBOARDING_PROVISIONING_STATUSES,
  type ClawOnboardingFlowStateInput,
  getClawOnboardingFlowState,
  getClawOnboardingStepProgress,
  hasPopulatedStatus,
} from './ClawOnboardingFlow.state';

function createStatus(status: KiloClawDashboardStatus['status']): KiloClawDashboardStatus {
  return {
    userId: 'user-1',
    sandboxId: 'sandbox-1',
    provider: status === null ? null : 'fly',
    runtimeId: status === null ? null : 'machine-1',
    storageId: status === null ? null : 'vol-1',
    region: status === null ? null : 'iad',
    name: null,
    status,
    provisionedAt: status === null ? null : 1,
    lastStartedAt: status === null ? null : 2,
    lastStoppedAt: null,
    envVarCount: 0,
    secretCount: 0,
    channelCount: 0,
    flyAppName: null,
    flyMachineId: null,
    flyVolumeId: null,
    flyRegion: status === null ? null : 'iad',
    machineSize: null,
    instanceType: null,
    volumeSizeGb: null,
    openclawVersion: null,
    imageVariant: null,
    trackedImageTag: null,
    trackedImageDigest: null,
    googleConnected: false,
    googleOAuthConnected: false,
    googleOAuthStatus: 'disconnected',
    googleOAuthAccountEmail: null,
    googleOAuthCapabilities: [],
    gmailNotificationsEnabled: false,
    execSecurity: null,
    execAsk: null,
    botName: null,
    botNature: null,
    botVibe: null,
    botEmoji: null,
    userLocation: null,
    userTimezone: null,
    workerUrl: 'https://claw.kilo.ai',
    controllerCapabilitiesVersion: null,
    instanceId: null,
    inboundEmailAddress: null,
    inboundEmailEnabled: false,
    scheduledAction: null,
  };
}

function createInput(
  overrides: Partial<ClawOnboardingFlowStateInput> = {}
): ClawOnboardingFlowStateInput {
  return {
    status: undefined,
    mode: 'create-first',
    createSetupStarted: false,
    onboardingStep: 'identity',
    hasBotIdentity: false,
    gatewayState: null,
    ...overrides,
  };
}

describe('ClawOnboardingFlow state machine', () => {
  test('detects populated statuses', () => {
    expect(hasPopulatedStatus(undefined)).toBe(false);
    expect(hasPopulatedStatus(createStatus(null))).toBe(false);
    expect(hasPopulatedStatus(createStatus('running'))).toBe(true);
  });

  test('renders identity before provisioning starts', () => {
    const state = getClawOnboardingFlowState(createInput());

    expect(state.renderStep).toBe('identity');
    expect(state.createSetupActive).toBe(false);
    expect(state.instanceStatus).toBeNull();
  });

  test('renders identity immediately after provisioning is requested before status is available', () => {
    const state = getClawOnboardingFlowState(
      createInput({
        createSetupStarted: true,
        status: undefined,
      })
    );

    expect(state.renderStep).toBe('identity');
    expect(state.createSetupActive).toBe(true);
    expect(state.instanceStatus).toBeNull();
  });

  test('keeps create setup active once an instance status exists', () => {
    const state = getClawOnboardingFlowState(
      createInput({
        status: createStatus('starting'),
      })
    );

    expect(state.renderStep).toBe('identity');
    expect(state.createSetupActive).toBe(true);
  });

  test('maps the normal create-first wizard steps', () => {
    expect(getClawOnboardingFlowState(createInput({ createSetupStarted: true })).renderStep).toBe(
      'identity'
    );
    expect(
      getClawOnboardingFlowState(
        createInput({
          createSetupStarted: true,
          onboardingStep: 'calendar',
          hasBotIdentity: true,
        })
      ).renderStep
    ).toBe('calendar');
    expect(
      getClawOnboardingFlowState(
        createInput({
          createSetupStarted: true,
          onboardingStep: 'email',
          hasBotIdentity: true,
        })
      ).renderStep
    ).toBe('email');
    expect(
      getClawOnboardingFlowState(
        createInput({
          createSetupStarted: true,
          onboardingStep: 'provisioning',
          hasBotIdentity: true,
        })
      ).renderStep
    ).toBe('provisioning');
    expect(
      getClawOnboardingFlowState(
        createInput({
          createSetupStarted: true,
          onboardingStep: 'done',
        })
      ).renderStep
    ).toBe('complete');
  });

  test('the active wizard has five steps when all admin-gated steps are visible', () => {
    // Channels and pairing were removed from the active wizard. The
    // counter is 5 with all admin-gated steps visible: identity,
    // calendar, email, interests, provisioning. Non-admins skip the
    // calendar and interests steps (see the describe block below).
    const defaultState = getClawOnboardingFlowState(createInput());
    expect(defaultState.totalSteps).toBe(5);
    expect(defaultState.currentStep).toBe(1);
  });

  test('getClawOnboardingStepProgress returns correct live current and total steps', () => {
    expect(getClawOnboardingStepProgress('identity')).toEqual({
      currentStep: 1,
      totalSteps: 5,
    });
    expect(getClawOnboardingStepProgress('calendar')).toEqual({
      currentStep: 2,
      totalSteps: 5,
    });
    expect(getClawOnboardingStepProgress('email')).toEqual({
      currentStep: 3,
      totalSteps: 5,
    });
    expect(getClawOnboardingStepProgress('interests')).toEqual({
      currentStep: 4,
      totalSteps: 5,
    });
    expect(getClawOnboardingStepProgress('provisioning')).toEqual({
      currentStep: 5,
      totalSteps: 5,
    });
    expect(getClawOnboardingStepProgress('done')).toEqual({ currentStep: 5, totalSteps: 5 });
  });

  test.each(CLAW_ONBOARDING_PROVISIONING_STATUSES)(
    'renders the post-provisioning spinner while machine status is %s',
    status => {
      const state = getClawOnboardingFlowState(
        createInput({
          mode: 'post-provisioning',
          status: createStatus(status),
        })
      );

      expect(state.renderStep).toBe('provisioning');
      expect(state.postProvisioningReady).toBe(false);
    }
  );

  test('renders an error when the setup request failed', () => {
    expect(
      getClawOnboardingFlowState(
        createInput({
          createSetupStarted: true,
          setupFailed: true,
          onboardingStep: 'provisioning',
          hasBotIdentity: true,
          status: undefined,
        })
      ).renderStep
    ).toBe('error');
    expect(
      getClawOnboardingFlowState(
        createInput({
          mode: 'post-provisioning',
          setupFailed: true,
          status: createStatus(null),
        })
      ).renderStep
    ).toBe('error');
    expect(
      getClawOnboardingFlowState(
        createInput({
          mode: 'post-provisioning',
          setupFailed: true,
          status: createStatus('starting'),
        })
      ).renderStep
    ).toBe('error');
  });

  test('does not let an old setup failure override a running instance', () => {
    const state = getClawOnboardingFlowState(
      createInput({
        mode: 'post-provisioning',
        setupFailed: true,
        status: createStatus('running'),
      })
    );

    expect(state.renderStep).toBe('complete');
    expect(state.postProvisioningReady).toBe(true);
  });

  test.each(CLAW_ONBOARDING_ERROR_STATUSES)(
    'renders an error when machine status is %s',
    status => {
      expect(
        getClawOnboardingFlowState(
          createInput({
            mode: 'post-provisioning',
            status: createStatus(status),
          })
        ).renderStep
      ).toBe('error');
      expect(
        getClawOnboardingFlowState(
          createInput({
            createSetupStarted: true,
            onboardingStep: 'provisioning',
            hasBotIdentity: true,
            status: createStatus(status),
          })
        ).renderStep
      ).toBe('error');
    }
  );

  test('renders provisioning when post-provisioning has no provisioned DO', () => {
    // status undefined — no DO state at all (e.g. credit enrollment created DB
    // row + subscription but never triggered provision)
    expect(getClawOnboardingFlowState(createInput({ mode: 'post-provisioning' })).renderStep).toBe(
      'provisioning'
    );
    // status with null machine status — DO exists but returned status: null
    expect(
      getClawOnboardingFlowState(
        createInput({ mode: 'post-provisioning', status: createStatus(null) })
      ).renderStep
    ).toBe('provisioning');
  });

  describe('when admin-gated steps are hidden (non-admin user)', () => {
    // A real non-admin has BOTH calendar and interests hidden (they share
    // the same admin gate). Each test passes both flags as `false` so the
    // total step count reflects the actual non-admin wizard: identity,
    // email, provisioning = 3 steps.
    test('drops calendar and interests from total step count', () => {
      const nonAdmin = getClawOnboardingFlowState(
        createInput({ hasCalendarStep: false, hasInterestsStep: false })
      );
      expect(nonAdmin.totalSteps).toBe(3);
      expect(nonAdmin.hasCalendarStep).toBe(false);
      expect(nonAdmin.hasInterestsStep).toBe(false);
    });

    test('redirects calendar render step to email in create-first mode', () => {
      const state = getClawOnboardingFlowState(
        createInput({
          createSetupStarted: true,
          onboardingStep: 'calendar',
          hasBotIdentity: true,
          hasCalendarStep: false,
          hasInterestsStep: false,
        })
      );

      expect(state.renderStep).toBe('email');
    });

    test('redirects calendar render step to email in post-provisioning mode', () => {
      const state = getClawOnboardingFlowState(
        createInput({
          mode: 'post-provisioning',
          status: createStatus('running'),
          onboardingStep: 'calendar',
          hasBotIdentity: true,
          gatewayState: 'running',
          hasCalendarStep: false,
          hasInterestsStep: false,
        })
      );

      expect(state.renderStep).toBe('email');
    });

    test('reports email as step 2 of 3 even when stored onboardingStep is calendar', () => {
      // A non-admin briefly sitting on onboardingStep='calendar' (e.g. via a
      // stale URL) gets normalized for both the rendered step and the
      // progress indicator so the header doesn't read "Step 0 of 3".
      const state = getClawOnboardingFlowState(
        createInput({
          createSetupStarted: true,
          onboardingStep: 'calendar',
          hasBotIdentity: true,
          hasCalendarStep: false,
          hasInterestsStep: false,
        })
      );

      expect(state.renderStep).toBe('email');
      expect(state.currentStep).toBe(2);
      expect(state.totalSteps).toBe(3);
    });

    test('redirects interests render step to provisioning in create-first mode', () => {
      const state = getClawOnboardingFlowState(
        createInput({
          createSetupStarted: true,
          onboardingStep: 'interests',
          hasBotIdentity: true,
          hasCalendarStep: false,
          hasInterestsStep: false,
        })
      );

      expect(state.renderStep).toBe('provisioning');
    });

    test('getClawOnboardingStepProgress positions remaining steps correctly without calendar or interests', () => {
      expect(getClawOnboardingStepProgress('identity', false, false)).toEqual({
        currentStep: 1,
        totalSteps: 3,
      });
      expect(getClawOnboardingStepProgress('email', false, false)).toEqual({
        currentStep: 2,
        totalSteps: 3,
      });
      expect(getClawOnboardingStepProgress('provisioning', false, false)).toEqual({
        currentStep: 3,
        totalSteps: 3,
      });
      expect(getClawOnboardingStepProgress('done', false, false)).toEqual({
        currentStep: 3,
        totalSteps: 3,
      });
    });
  });

  test('renders calendar in post-provisioning mode when explicit resume is requested', () => {
    // After the OAuth full-page reload, the wizard often remounts in
    // post-provisioning mode because the instance row is now visible.
    // The resume path sets onboardingStep='calendar' so the user lands
    // back on the calendar step rather than getting auto-redirected.
    const state = getClawOnboardingFlowState(
      createInput({
        mode: 'post-provisioning',
        status: createStatus('running'),
        onboardingStep: 'calendar',
        hasBotIdentity: true,
        gatewayState: 'running',
      })
    );

    expect(state.renderStep).toBe('calendar');
  });

  test('renders calendar in post-provisioning mode even before the gateway is ready', () => {
    // The OAuth round-trip can complete before the gateway boots; respect
    // the calendar resume regardless of postProvisioningReady.
    const state = getClawOnboardingFlowState(
      createInput({
        mode: 'post-provisioning',
        status: createStatus('starting'),
        onboardingStep: 'calendar',
        hasBotIdentity: true,
      })
    );

    expect(state.renderStep).toBe('calendar');
  });

  test('honors email onboarding step in post-provisioning mode', () => {
    const state = getClawOnboardingFlowState(
      createInput({
        mode: 'post-provisioning',
        status: createStatus('running'),
        onboardingStep: 'email',
        hasBotIdentity: true,
        gatewayState: 'running',
      })
    );

    expect(state.renderStep).toBe('email');
  });

  test('honors provisioning onboarding step in post-provisioning mode', () => {
    const state = getClawOnboardingFlowState(
      createInput({
        mode: 'post-provisioning',
        status: createStatus('starting'),
        onboardingStep: 'provisioning',
        hasBotIdentity: true,
      })
    );

    expect(state.renderStep).toBe('provisioning');
  });

  test('renders complete in post-provisioning mode once the machine is running', () => {
    const state = getClawOnboardingFlowState(
      createInput({
        mode: 'post-provisioning',
        status: createStatus('running'),
        gatewayState: 'crashed',
      })
    );

    expect(state.renderStep).toBe('complete');
    expect(state.postProvisioningReady).toBe(true);
    expect(state.gatewayReady).toBe(false);
    expect(state.instanceRunning).toBe(false);
  });

  test('uses gateway status only for gateway readiness and instance-running checks', () => {
    const runningState = getClawOnboardingFlowState(
      createInput({
        createSetupStarted: true,
        status: createStatus('running'),
        gatewayState: 'running',
      })
    );
    const startingGatewayState = getClawOnboardingFlowState(
      createInput({
        createSetupStarted: true,
        status: createStatus('running'),
        gatewayState: 'starting',
      })
    );

    expect(runningState.isRunning).toBe(true);
    expect(runningState.gatewayReady).toBe(true);
    expect(runningState.instanceRunning).toBe(true);
    expect(startingGatewayState.isRunning).toBe(true);
    expect(startingGatewayState.gatewayReady).toBe(false);
    expect(startingGatewayState.instanceRunning).toBe(false);
  });

  test('normalizes impossible local wizard states to the earliest safe prerequisite', () => {
    expect(
      getClawOnboardingFlowState(
        createInput({
          createSetupStarted: true,
          onboardingStep: 'provisioning',
          hasBotIdentity: true,
        })
      ).renderStep
    ).toBe('provisioning');
  });
});
