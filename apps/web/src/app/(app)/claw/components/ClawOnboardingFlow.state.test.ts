import { describe, expect, test } from '@jest/globals';
import type { KiloClawDashboardStatus } from '@/lib/kiloclaw/types';
import {
  type ClawOnboardingFlowStateInput,
  getClawOnboardingFlowState,
  hasPopulatedStatus,
  isPairingChannel,
} from './ClawOnboardingFlow.state';

const machineStatuses = [
  'provisioned',
  'starting',
  'restarting',
  'recovering',
  'running',
  'stopped',
  'destroying',
  'restoring',
] satisfies NonNullable<KiloClawDashboardStatus['status']>[];

const waitingMachineStatuses = machineStatuses.filter(status => status !== 'running');

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

  test('renders the create card before provisioning starts', () => {
    const state = getClawOnboardingFlowState(createInput());

    expect(state.renderStep).toBe('create-instance');
    expect(state.createSetupActive).toBe(false);
    expect(state.instanceStatus).toBeNull();
  });

  test('renders identity after provisioning has been requested', () => {
    const state = getClawOnboardingFlowState(
      createInput({
        createSetupStarted: true,
      })
    );

    expect(state.renderStep).toBe('identity');
    expect(state.createSetupActive).toBe(true);
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

  test('uses six steps only when the selected channel requires pairing', () => {
    expect(
      getClawOnboardingFlowState(createInput({ selectedChannelId: 'telegram' })).totalSteps
    ).toBe(6);
    expect(
      getClawOnboardingFlowState(createInput({ selectedChannelId: 'discord' })).totalSteps
    ).toBe(6);
    expect(getClawOnboardingFlowState(createInput({ selectedChannelId: 'slack' })).totalSteps).toBe(
      5
    );
    expect(getClawOnboardingFlowState(createInput()).totalSteps).toBe(5);
  });

  test.each(waitingMachineStatuses)(
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

  test('renders the post-provisioning spinner before a populated status exists', () => {
    expect(getClawOnboardingFlowState(createInput({ mode: 'post-provisioning' })).renderStep).toBe(
      'provisioning'
    );
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
