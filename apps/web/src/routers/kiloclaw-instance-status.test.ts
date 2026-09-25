import { describe, expect, it } from '@jest/globals';
import {
  createFakeSeedInstanceStatus,
  createNoInstanceStatus,
  isClientAbortError,
  isFakeSeedInstance,
  statusUnavailableError,
} from '@/routers/kiloclaw-instance-status';
import type { ActiveKiloClawInstance } from '@/lib/kiloclaw/instance-registry';

const fakeSeedInstance: ActiveKiloClawInstance = {
  id: 'instance-1',
  userId: 'user-1',
  sandboxId: 'ki_fake_org_0123456789abcdef',
  organizationId: 'org-1',
  name: 'Fake local org KiloClaw',
  inboundEmailEnabled: true,
};

const realInstance: ActiveKiloClawInstance = {
  ...fakeSeedInstance,
  sandboxId: 'ki_0123456789abcdef',
  organizationId: null,
  name: null,
  inboundEmailEnabled: false,
};

describe('isFakeSeedInstance', () => {
  it('matches the DB-only fixture sandbox prefix', () => {
    expect(isFakeSeedInstance(fakeSeedInstance)).toBe(true);
  });

  it('does not match a real instance sandbox id', () => {
    expect(isFakeSeedInstance(realInstance)).toBe(false);
  });
});

describe('createNoInstanceStatus', () => {
  it('returns the no-instance sentinel shape', () => {
    expect(createNoInstanceStatus('user-1', 'https://claw.test')).toEqual({
      userId: 'user-1',
      sandboxId: null,
      provider: null,
      runtimeId: null,
      storageId: null,
      region: null,
      status: null,
      provisionedAt: null,
      lastStartedAt: null,
      lastStoppedAt: null,
      envVarCount: 0,
      secretCount: 0,
      channelCount: 0,
      flyAppName: null,
      flyMachineId: null,
      flyVolumeId: null,
      flyRegion: null,
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
      workerUrl: 'https://claw.test',
      controllerCapabilitiesVersion: null,
      name: null,
      instanceId: null,
      inboundEmailAddress: null,
      inboundEmailEnabled: false,
      scheduledAction: null,
    });
  });
});

describe('createFakeSeedInstanceStatus', () => {
  it('reports the fixture as a stopped local docker instance', () => {
    const status = createFakeSeedInstanceStatus(fakeSeedInstance, 'https://claw.test');

    expect(status).toMatchObject({
      userId: 'user-1',
      sandboxId: fakeSeedInstance.sandboxId,
      provider: 'docker-local',
      runtimeId: fakeSeedInstance.sandboxId,
      storageId: fakeSeedInstance.sandboxId,
      region: 'local',
      status: 'stopped',
      trackedImageTag: 'fake-local-instance',
      workerUrl: 'https://claw.test',
      name: 'Fake local org KiloClaw',
      instanceId: 'instance-1',
      inboundEmailEnabled: true,
    });
    expect(status.provisionedAt).toEqual(expect.any(Number));
  });
});

describe('isClientAbortError', () => {
  const disconnected = AbortSignal.abort();

  it('matches an AbortError by name', () => {
    expect(
      isClientAbortError(Object.assign(new Error('x'), { name: 'AbortError' }), disconnected)
    ).toBe(true);
  });

  it('matches the raw "aborted" message from the dev-stack log', () => {
    expect(isClientAbortError(new Error('aborted'), disconnected)).toBe(true);
  });

  it('matches the undici ABORT_ERR code', () => {
    expect(
      isClientAbortError(Object.assign(new Error('x'), { code: 'ABORT_ERR' }), disconnected)
    ).toBe(true);
  });

  it('matches the undici UND_ERR_ABORTED code', () => {
    expect(
      isClientAbortError(Object.assign(new Error('x'), { code: 'UND_ERR_ABORTED' }), disconnected)
    ).toBe(true);
  });

  it('does not mistake an upstream abort for a disconnected client', () => {
    const upstreamAbort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    expect(isClientAbortError(upstreamAbort)).toBe(false);
    expect(isClientAbortError(upstreamAbort, new AbortController().signal)).toBe(false);
    expect(isClientAbortError(new Error('upstream 500'), disconnected)).toBe(false);
    expect(isClientAbortError('aborted', disconnected)).toBe(false);
    expect(isClientAbortError(null, disconnected)).toBe(false);
  });
});

describe('statusUnavailableError', () => {
  it('maps a client abort to CLIENT_CLOSED_REQUEST and keeps the cause', () => {
    const cause = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const error = statusUnavailableError(cause, AbortSignal.abort());

    expect(error.code).toBe('CLIENT_CLOSED_REQUEST');
    expect(error.message).toBe('Client disconnected before the KiloClaw status could be read');
    expect(error.cause).toBe(cause);
  });

  it('reports an upstream abort as BAD_GATEWAY while the caller is connected', () => {
    const cause = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const error = statusUnavailableError(cause, new AbortController().signal);

    expect(error.code).toBe('BAD_GATEWAY');
    expect(error.cause).toBe(cause);
  });

  it('maps any other failure to BAD_GATEWAY and keeps the cause', () => {
    const cause = new Error('upstream 500');
    const error = statusUnavailableError(cause);

    expect(error.code).toBe('BAD_GATEWAY');
    expect(error.message).toBe('KiloClaw instance status is unavailable');
    expect(error.cause).toBe(cause);
  });
});
