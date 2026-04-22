import { describe, expect, test } from '@jest/globals';
import type { KiloClawDashboardStatus } from '@/lib/kiloclaw/types';
import {
  CLAW_ONBOARDING_ERROR_STATUSES,
  CLAW_ONBOARDING_PROVISIONING_STATUSES,
  type ClawOnboardingFlowStateInput,
  getClawOnboardingFlowState,
  getClawOnboardingStepProgress,
  hasPopulatedStatus,
  isPairingChannel,
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
    workerUrl: 'https://claw.kilo.ai',
    instanceId: null,
    inboundEmailAddress: null,
    inboundEmailEnabled: false,
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
    selectedPreset: null,
    hasBotIdentity: false,
    selectedChannelId: null,
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

  test('detects channels that need a pairing step', () => {
    expect(isPairingChannel('telegram')).toBe(true);
    expect(isPairingChannel('discord')).toBe(true);
    expect(isPairingChannel('slack')).toBe(false);
    expect(isPairingChannel(null)).toBe(false);
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
          onboardingStep: 'permissions',
          hasBotIdentity: true,
        })
      ).renderStep
    ).toBe('permissions');
    expect(
      getClawOnboardingFlowState(
        createInput({
          createSetupStarted: true,
          onboardingStep: 'channels',
          hasBotIdentity: true,
          selectedPreset: 'always-ask',
        })
      ).renderStep
    ).toBe('channels');
    expect(
      getClawOnboardingFlowState(
        createInput({
          createSetupStarted: true,
          onboardingStep: 'provisioning',
          hasBotIdentity: true,
          selectedPreset: 'always-ask',
        })
      ).renderStep
    ).toBe('provisioning');
    expect(
      getClawOnboardingFlowState(
        createInput({
          createSetupStarted: true,
          onboardingStep: 'pairing',
          hasBotIdentity: true,
          selectedPreset: 'always-ask',
          selectedChannelId: 'telegram',
        })
      ).renderStep
    ).toBe('pairing');
    expect(
      getClawOnboardingFlowState(
        createInput({
          createSetupStarted: true,
          onboardingStep: 'done',
        })
      ).renderStep
    ).toBe('complete');
  });

  test('uses five steps only when the selected channel requires pairing', () => {
    const pairingTelegram = getClawOnboardingFlowState(
      createInput({ selectedChannelId: 'telegram' })
    );
    expect(pairingTelegram.totalSteps).toBe(5);
    expect(pairingTelegram.currentStep).toBe(1);

    const pairingDiscord = getClawOnboardingFlowState(
      createInput({ selectedChannelId: 'discord' })
    );
    expect(pairingDiscord.totalSteps).toBe(5);
    expect(pairingDiscord.currentStep).toBe(1);

    const noPairingSlack = getClawOnboardingFlowState(createInput({ selectedChannelId: 'slack' }));
    expect(noPairingSlack.totalSteps).toBe(4);
    expect(noPairingSlack.currentStep).toBe(1);

    const defaultState = getClawOnboardingFlowState(createInput());
    expect(defaultState.totalSteps).toBe(4);
    expect(defaultState.currentStep).toBe(1);
  });

  test('getClawOnboardingStepProgress returns correct current and total steps', () => {
    expect(getClawOnboardingStepProgress('identity', false)).toEqual({
      currentStep: 1,
      totalSteps: 4,
    });
    expect(getClawOnboardingStepProgress('permissions', false)).toEqual({
      currentStep: 2,
      totalSteps: 4,
    });
    expect(getClawOnboardingStepProgress('channels', false)).toEqual({
      currentStep: 3,
      totalSteps: 4,
    });
    expect(getClawOnboardingStepProgress('provisioning', false)).toEqual({
      currentStep: 4,
      totalSteps: 4,
    });
    expect(getClawOnboardingStepProgress('done', false)).toEqual({ currentStep: 4, totalSteps: 4 });

    expect(getClawOnboardingStepProgress('identity', true)).toEqual({
      currentStep: 1,
      totalSteps: 5,
    });
    expect(getClawOnboardingStepProgress('permissions', true)).toEqual({
      currentStep: 2,
      totalSteps: 5,
    });
    expect(getClawOnboardingStepProgress('channels', true)).toEqual({
      currentStep: 3,
      totalSteps: 5,
    });
    expect(getClawOnboardingStepProgress('provisioning', true)).toEqual({
      currentStep: 4,
      totalSteps: 5,
    });
    expect(getClawOnboardingStepProgress('pairing', true)).toEqual({
      currentStep: 5,
      totalSteps: 5,
    });
    expect(getClawOnboardingStepProgress('done', true)).toEqual({ currentStep: 5, totalSteps: 5 });
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
          selectedPreset: 'always-ask',
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
            selectedPreset: 'always-ask',
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
          onboardingStep: 'permissions',
          hasBotIdentity: false,
        })
      ).renderStep
    ).toBe('identity');
    expect(
      getClawOnboardingFlowState(
        createInput({
          createSetupStarted: true,
          onboardingStep: 'channels',
          hasBotIdentity: true,
          selectedPreset: null,
        })
      ).renderStep
    ).toBe('permissions');
    expect(
      getClawOnboardingFlowState(
        createInput({
          createSetupStarted: true,
          onboardingStep: 'provisioning',
          hasBotIdentity: true,
          selectedPreset: null,
        })
      ).renderStep
    ).toBe('permissions');
    expect(
      getClawOnboardingFlowState(
        createInput({
          createSetupStarted: true,
          onboardingStep: 'pairing',
          hasBotIdentity: true,
          selectedPreset: 'always-ask',
          selectedChannelId: 'slack',
        })
      ).renderStep
    ).toBe('complete');
  });
});
