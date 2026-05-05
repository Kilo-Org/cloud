import { describe, expect, test } from '@jest/globals';
import type { KiloClawDashboardStatus } from '@/lib/kiloclaw/types';
import { getClawNewStatusQueryForBoundary } from './ClawNewClient.state';

const baseStatus: KiloClawDashboardStatus = {
  userId: 'user-1',
  sandboxId: 'sandbox-1',
  provider: 'fly',
  runtimeId: 'machine-1',
  storageId: 'vol-1',
  region: 'iad',
  name: null,
  status: 'running',
  provisionedAt: 1,
  lastStartedAt: 2,
  lastStoppedAt: 3,
  envVarCount: 1,
  secretCount: 2,
  channelCount: 3,
  flyAppName: null,
  flyMachineId: null,
  flyVolumeId: null,
  flyRegion: null,
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
  instanceId: 'instance-1',
  inboundEmailAddress: 'amber-river-quiet-maple@kiloclaw.ai',
  inboundEmailEnabled: true,
};

function createStatus(instanceId: string | null = 'instance-1'): KiloClawDashboardStatus {
  return {
    ...baseStatus,
    instanceId,
  };
}

describe('getClawNewStatusQueryForBoundary', () => {
  test('keeps cached status rendered after a billing refetch', () => {
    const status = createStatus('instance-1');

    const result = getClawNewStatusQueryForBoundary({
      statusQuery: {
        data: status,
        dataUpdatedAt: 100,
        isLoading: false,
        error: null,
      },
      setupFailed: false,
      billingInstanceId: 'instance-1',
    });

    expect(result).toEqual({
      data: status,
      isLoading: false,
      error: null,
    });
  });

  test('loads when there is no status payload to render', () => {
    const result = getClawNewStatusQueryForBoundary({
      statusQuery: {
        data: undefined,
        dataUpdatedAt: 0,
        isLoading: false,
        error: null,
      },
      setupFailed: false,
      billingInstanceId: 'instance-1',
    });

    expect(result).toEqual({
      data: undefined,
      isLoading: true,
      error: null,
    });
  });

  test('lets setup failure render the onboarding error state without loading', () => {
    const result = getClawNewStatusQueryForBoundary({
      statusQuery: {
        data: undefined,
        dataUpdatedAt: 0,
        isLoading: true,
        error: new Error('network issue'),
      },
      setupFailed: true,
      billingInstanceId: 'instance-1',
    });

    expect(result).toEqual({
      data: undefined,
      isLoading: false,
      error: null,
    });
  });

  test('keeps cached status rendered when a background refetch errors', () => {
    const status = createStatus('instance-1');

    const result = getClawNewStatusQueryForBoundary({
      statusQuery: {
        data: status,
        dataUpdatedAt: 100,
        isLoading: false,
        error: new Error('network issue'),
      },
      setupFailed: false,
      billingInstanceId: 'instance-1',
    });

    expect(result).toEqual({
      data: status,
      isLoading: false,
      error: null,
    });
  });

  test('does not render stale status from a different concrete instance', () => {
    const result = getClawNewStatusQueryForBoundary({
      statusQuery: {
        data: createStatus('instance-1'),
        dataUpdatedAt: 100,
        isLoading: false,
        error: null,
      },
      setupFailed: false,
      billingInstanceId: 'instance-2',
    });

    expect(result).toEqual({
      data: undefined,
      isLoading: true,
      error: null,
    });
  });

  test('does not render stale no-instance status for an active billing instance', () => {
    const result = getClawNewStatusQueryForBoundary({
      statusQuery: {
        data: {
          ...createStatus(null),
          status: null,
        },
        dataUpdatedAt: 100,
        isLoading: false,
        error: null,
      },
      setupFailed: false,
      billingInstanceId: 'instance-1',
    });

    expect(result).toEqual({
      data: undefined,
      isLoading: true,
      error: null,
    });
  });

  test('allows legacy status rows that do not expose an instance id', () => {
    const status = createStatus(null);

    const result = getClawNewStatusQueryForBoundary({
      statusQuery: {
        data: status,
        dataUpdatedAt: 100,
        isLoading: false,
        error: null,
      },
      setupFailed: false,
      billingInstanceId: 'instance-1',
    });

    expect(result).toEqual({
      data: status,
      isLoading: false,
      error: null,
    });
  });
});
