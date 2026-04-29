import { describe, expect, it } from 'vitest';

import { formatStartFailureReason, readyPushProbeActive } from './lifecycle-push';
import { READY_PUSH_PROBE_WINDOW_MS } from '../config';
import type { InstanceMutableState } from '../durable-objects/kiloclaw-instance/types';

function stateStub(overrides: Partial<InstanceMutableState> = {}): InstanceMutableState {
  return {
    loaded: true,
    userId: 'user-1',
    sandboxId: 'sandbox-1',
    orgId: null,
    provider: 'fly',
    providerState: null,
    status: 'running',
    envVars: null,
    encryptedSecrets: null,
    kilocodeApiKey: null,
    kilocodeApiKeyExpiresAt: null,
    kilocodeDefaultModel: null,
    userTimezone: null,
    userLocation: null,
    kiloExaSearchMode: null,
    channels: null,
    googleCredentials: null,
    googleOAuthConnection: null,
    googleWorkspaceToolsEnabled: false,
    googleWorkspaceConfigSyncPending: false,
    googleWorkspaceConfigSyncError: null,
    googleWorkspaceConfigSyncedAt: null,
    provisionedAt: Date.now(),
    startingAt: null,
    restartingAt: null,
    recoveryStartedAt: null,
    restartUpdateSent: false,
    pendingStartReason: null,
    lastStartedAt: Date.now(),
    lastStoppedAt: null,
    flyAppName: 'acct-test',
    flyMachineId: 'machine-1',
    flyVolumeId: 'vol-1',
    flyRegion: 'iad',
    machineSize: null,
    healthCheckFailCount: 0,
    pendingDestroyMachineId: null,
    pendingDestroyVolumeId: null,
    pendingPostgresMarkOnFinalize: false,
    lastMetadataRecoveryAt: null,
    openclawVersion: null,
    imageVariant: null,
    trackedImageTag: null,
    trackedImageDigest: null,
    lastDestroyErrorOp: null,
    lastDestroyErrorStatus: null,
    lastDestroyErrorMessage: null,
    lastDestroyErrorAt: null,
    lastStartErrorMessage: null,
    lastStartErrorAt: null,
    lastRestartErrorMessage: null,
    lastRestartErrorAt: null,
    pendingRecoveryVolumeId: null,
    recoveryPreviousVolumeId: null,
    recoveryPreviousVolumeCleanupAfter: null,
    lastRecoveryErrorMessage: null,
    lastRecoveryErrorAt: null,
    lastBoundMachineRecoveryAt: null,
    instanceFeatures: [],
    gmailNotificationsEnabled: false,
    gmailLastHistoryId: null,
    gmailPushOidcEmail: null,
    execSecurity: null,
    execAsk: null,
    execPresetApplyPending: false,
    botName: null,
    botNature: null,
    botVibe: null,
    botEmoji: null,
    botIdentityApplyPending: false,
    channelsApplyPending: false,
    previousVolumeId: null,
    restoreStartedAt: null,
    preRestoreStatus: null,
    pendingRestoreVolumeId: null,
    instanceReadyEmailSent: false,
    instanceReadyPushSent: false,
    startFailurePushSentForAttempt: false,
    customSecretMeta: null,
    streamChatApiKey: null,
    streamChatBotUserId: null,
    streamChatBotUserToken: null,
    streamChatChannelId: null,
    vectorMemoryEnabled: false,
    vectorMemoryModel: null,
    dreamingEnabled: false,
    lastLiveCheckAt: null,
    ...overrides,
  };
}

describe('formatStartFailureReason', () => {
  it('returns a specific sentence for every known label', () => {
    expect(formatStartFailureReason('starting_timeout')).toContain('Setup is taking longer');
    expect(formatStartFailureReason('starting_timeout_with_machine')).toContain(
      "didn't finish booting"
    );
    expect(formatStartFailureReason('starting_machine_gone')).toContain('went missing');
    expect(formatStartFailureReason('starting_timeout_transient_error')).toContain('temporary');
    expect(formatStartFailureReason('fly_failed_state')).toContain('failed state');
  });

  it('falls back to a generic sentence for unknown labels', () => {
    expect(formatStartFailureReason('some_new_label')).toBe('Start failed.');
  });
});

describe('readyPushProbeActive', () => {
  const now = 1_700_000_000_000;

  it('returns false when the flag is already set', () => {
    const state = stateStub({
      instanceReadyPushSent: true,
      lastStartedAt: now - 1000,
    });
    expect(readyPushProbeActive(state, now)).toBe(false);
  });

  it('returns false outside the 5-minute window', () => {
    const state = stateStub({
      instanceReadyPushSent: false,
      lastStartedAt: now - READY_PUSH_PROBE_WINDOW_MS - 1,
    });
    expect(readyPushProbeActive(state, now)).toBe(false);
  });

  it('returns true while inside the window', () => {
    const state = stateStub({
      instanceReadyPushSent: false,
      lastStartedAt: now - 10_000,
    });
    expect(readyPushProbeActive(state, now)).toBe(true);
  });

  it('uses startingAt when lastStartedAt is null', () => {
    const state = stateStub({
      status: 'starting',
      instanceReadyPushSent: false,
      lastStartedAt: null,
      startingAt: now - 1000,
    });
    expect(readyPushProbeActive(state, now)).toBe(true);
  });

  it('returns false when status is not starting/running', () => {
    const state = stateStub({
      status: 'stopped',
      instanceReadyPushSent: false,
      lastStartedAt: now - 1000,
    });
    expect(readyPushProbeActive(state, now)).toBe(false);
  });

  it('returns false when both startingAt and lastStartedAt are null', () => {
    const state = stateStub({
      instanceReadyPushSent: false,
      lastStartedAt: null,
      startingAt: null,
    });
    expect(readyPushProbeActive(state, now)).toBe(false);
  });
});
