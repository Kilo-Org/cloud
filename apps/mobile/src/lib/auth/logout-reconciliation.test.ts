import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type LogoutCleanupTombstone } from '@/lib/auth/logout-cleanup';

const cleanupMock = vi.hoisted(() => ({
  readLogoutCleanupTombstone: vi.fn<() => Promise<LogoutCleanupTombstone | null>>(),
  deleteLogoutCleanupTombstone: vi.fn().mockResolvedValue(undefined),
  isNotFoundTrpcError: (error: unknown) => {
    if (typeof error !== 'object' || error === null) {
      return false;
    }
    const candidate = error as { code?: unknown; data?: { code?: unknown } };
    return candidate.code === 'NOT_FOUND' || candidate.data?.code === 'NOT_FOUND';
  },
}));

const trpcMock = vi.hoisted(() => ({
  revokeDeviceSessionById: { mutate: vi.fn() },
  unregisterPushToken: { mutate: vi.fn() },
}));

const notificationsMock = vi.hoisted(() => ({
  getDevicePushTokenOutcome: vi.fn(),
}));

/* eslint-disable import/first */
vi.mock('@/lib/auth/logout-cleanup', () => cleanupMock);
vi.mock('@/lib/trpc', () => ({
  trpcClient: { user: trpcMock },
}));
vi.mock('@/lib/notifications', () => notificationsMock);

import { bumpAuthEpoch } from '@/lib/auth/auth-epoch';
import {
  attemptLogoutReconciliation,
  resetLogoutReconciliationForTests,
  TOMBSTONE_MAX_AGE_MS,
} from '@/lib/auth/logout-reconciliation';
/* eslint-enable import/first */

const DAY_MS = 24 * 60 * 60 * 1000;

function makeTombstone(overrides: Partial<LogoutCleanupTombstone> = {}): LogoutCleanupTombstone {
  return {
    userId: 'u1',
    deviceSessionId: 'session-1',
    pushToken: null,
    needsSessionRevoke: true,
    needsPushUnregister: true,
    failedAt: Date.now(),
    ...overrides,
  };
}

describe('attemptLogoutReconciliation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetLogoutReconciliationForTests();
    cleanupMock.readLogoutCleanupTombstone.mockResolvedValue(null);
    cleanupMock.deleteLogoutCleanupTombstone.mockResolvedValue(undefined);
  });

  it('returns no-tombstone and makes no network call when nothing is pending', async () => {
    const outcome = await attemptLogoutReconciliation('u1');
    expect(outcome).toEqual({ kind: 'no-tombstone' });
    expect(trpcMock.revokeDeviceSessionById.mutate).not.toHaveBeenCalled();
    expect(trpcMock.unregisterPushToken.mutate).not.toHaveBeenCalled();
  });

  it('discards a tombstone older than 30 days without a network call', async () => {
    cleanupMock.readLogoutCleanupTombstone.mockResolvedValue(
      makeTombstone({ failedAt: Date.now() - TOMBSTONE_MAX_AGE_MS - DAY_MS })
    );

    const outcome = await attemptLogoutReconciliation('u1');

    expect(outcome).toEqual({ kind: 'expired-discarded' });
    expect(cleanupMock.deleteLogoutCleanupTombstone).toHaveBeenCalledTimes(1);
    expect(trpcMock.revokeDeviceSessionById.mutate).not.toHaveBeenCalled();
    expect(trpcMock.unregisterPushToken.mutate).not.toHaveBeenCalled();
  });

  it('leaves a different known user tombstone untouched', async () => {
    cleanupMock.readLogoutCleanupTombstone.mockResolvedValue(makeTombstone({ userId: 'u1' }));

    const outcome = await attemptLogoutReconciliation('u2');

    expect(outcome).toEqual({ kind: 'different-user-skipped' });
    expect(cleanupMock.deleteLogoutCleanupTombstone).not.toHaveBeenCalled();
    expect(trpcMock.revokeDeviceSessionById.mutate).not.toHaveBeenCalled();
  });

  it('completes every outstanding part for the owner and deletes the tombstone', async () => {
    cleanupMock.readLogoutCleanupTombstone.mockResolvedValue(makeTombstone());
    trpcMock.revokeDeviceSessionById.mutate.mockResolvedValue({ outcome: 'revoked' });
    notificationsMock.getDevicePushTokenOutcome.mockResolvedValue({
      kind: 'token',
      token: 'push-9',
    });
    trpcMock.unregisterPushToken.mutate.mockResolvedValue({ success: true });

    const outcome = await attemptLogoutReconciliation('u1');

    expect(outcome).toEqual({ kind: 'attempted', tombstoneDeleted: true });
    expect(trpcMock.revokeDeviceSessionById.mutate).toHaveBeenCalledWith({
      sessionId: 'session-1',
    });
    expect(trpcMock.unregisterPushToken.mutate).toHaveBeenCalledWith({ token: 'push-9' });
    expect(cleanupMock.deleteLogoutCleanupTombstone).toHaveBeenCalledTimes(1);
  });

  it('treats an already_revoked owner result as done', async () => {
    cleanupMock.readLogoutCleanupTombstone.mockResolvedValue(
      makeTombstone({ needsPushUnregister: false })
    );
    trpcMock.revokeDeviceSessionById.mutate.mockResolvedValue({ outcome: 'already_revoked' });

    const outcome = await attemptLogoutReconciliation('u1');

    expect(outcome).toEqual({ kind: 'attempted', tombstoneDeleted: true });
  });

  it('treats an owner NOT_FOUND as done (authoritative)', async () => {
    cleanupMock.readLogoutCleanupTombstone.mockResolvedValue(
      makeTombstone({ needsPushUnregister: false })
    );
    trpcMock.revokeDeviceSessionById.mutate.mockRejectedValue({
      data: { code: 'NOT_FOUND' },
    });

    const outcome = await attemptLogoutReconciliation('u1');

    expect(outcome).toEqual({ kind: 'attempted', tombstoneDeleted: true });
  });

  it('keeps the tombstone on a retryable revoke failure', async () => {
    cleanupMock.readLogoutCleanupTombstone.mockResolvedValue(
      makeTombstone({ needsPushUnregister: false })
    );
    trpcMock.revokeDeviceSessionById.mutate.mockRejectedValue(new Error('network down'));

    const outcome = await attemptLogoutReconciliation('u1');

    expect(outcome).toEqual({ kind: 'attempted', tombstoneDeleted: false });
    expect(cleanupMock.deleteLogoutCleanupTombstone).not.toHaveBeenCalled();
  });

  it('uses the stored push token when one exists instead of re-reading the device', async () => {
    cleanupMock.readLogoutCleanupTombstone.mockResolvedValue(
      makeTombstone({ needsSessionRevoke: false, pushToken: 'push-stored' })
    );
    trpcMock.unregisterPushToken.mutate.mockResolvedValue({ success: true });

    const outcome = await attemptLogoutReconciliation('u1');

    expect(outcome).toEqual({ kind: 'attempted', tombstoneDeleted: true });
    expect(trpcMock.unregisterPushToken.mutate).toHaveBeenCalledWith({ token: 'push-stored' });
    expect(notificationsMock.getDevicePushTokenOutcome).not.toHaveBeenCalled();
  });

  it('treats a re-read none outcome as terminal for the push part', async () => {
    cleanupMock.readLogoutCleanupTombstone.mockResolvedValue(
      makeTombstone({ needsSessionRevoke: false, pushToken: null })
    );
    notificationsMock.getDevicePushTokenOutcome.mockResolvedValue({ kind: 'none' });

    const outcome = await attemptLogoutReconciliation('u1');

    expect(outcome).toEqual({ kind: 'attempted', tombstoneDeleted: true });
    expect(trpcMock.unregisterPushToken.mutate).not.toHaveBeenCalled();
  });

  it('keeps the push part when the re-read lookup fails', async () => {
    cleanupMock.readLogoutCleanupTombstone.mockResolvedValue(
      makeTombstone({ needsSessionRevoke: false, pushToken: null })
    );
    notificationsMock.getDevicePushTokenOutcome.mockResolvedValue({ kind: 'lookup-failed' });

    const outcome = await attemptLogoutReconciliation('u1');

    expect(outcome).toEqual({ kind: 'attempted', tombstoneDeleted: false });
    expect(trpcMock.unregisterPushToken.mutate).not.toHaveBeenCalled();
  });

  it('keeps the push part when the unregister rejects', async () => {
    cleanupMock.readLogoutCleanupTombstone.mockResolvedValue(
      makeTombstone({ needsSessionRevoke: false, pushToken: 'push-stored' })
    );
    trpcMock.unregisterPushToken.mutate.mockRejectedValue(new Error('server 500'));

    const outcome = await attemptLogoutReconciliation('u1');

    expect(outcome).toEqual({ kind: 'attempted', tombstoneDeleted: false });
  });

  it('treats a null deviceSessionId as terminal for the session part', async () => {
    cleanupMock.readLogoutCleanupTombstone.mockResolvedValue(
      makeTombstone({ deviceSessionId: null, needsPushUnregister: false })
    );

    const outcome = await attemptLogoutReconciliation('u1');

    expect(outcome).toEqual({ kind: 'attempted', tombstoneDeleted: true });
    expect(trpcMock.revokeDeviceSessionById.mutate).not.toHaveBeenCalled();
  });

  it('does NOT treat NOT_FOUND as terminal for an identity-unknown tombstone', async () => {
    cleanupMock.readLogoutCleanupTombstone.mockResolvedValue(
      makeTombstone({ userId: null, needsPushUnregister: false })
    );
    trpcMock.revokeDeviceSessionById.mutate.mockRejectedValue({
      data: { code: 'NOT_FOUND' },
    });

    const outcome = await attemptLogoutReconciliation('u1');

    expect(outcome).toEqual({ kind: 'attempted', tombstoneDeleted: false });
    expect(cleanupMock.deleteLogoutCleanupTombstone).not.toHaveBeenCalled();
  });

  it('completes the session part for an identity-unknown tombstone on revoked', async () => {
    cleanupMock.readLogoutCleanupTombstone.mockResolvedValue(
      makeTombstone({ userId: null, needsPushUnregister: false })
    );
    trpcMock.revokeDeviceSessionById.mutate.mockResolvedValue({ outcome: 'revoked' });

    const outcome = await attemptLogoutReconciliation('u1');

    expect(outcome).toEqual({ kind: 'attempted', tombstoneDeleted: true });
  });

  it('skips a second attempt within the 60 s spacing window', async () => {
    cleanupMock.readLogoutCleanupTombstone.mockResolvedValue(makeTombstone());
    trpcMock.revokeDeviceSessionById.mutate.mockResolvedValue({ outcome: 'revoked' });
    notificationsMock.getDevicePushTokenOutcome.mockResolvedValue({ kind: 'none' });

    const first = await attemptLogoutReconciliation('u1');
    const second = await attemptLogoutReconciliation('u1');

    expect(first.kind).toBe('attempted');
    expect(second).toEqual({ kind: 'spacing-skipped' });
  });

  it('single-flights concurrent attempts', async () => {
    const gate = { release: null as (() => void) | null };
    const readGate = new Promise<void>(resolve => {
      gate.release = resolve;
    });
    cleanupMock.readLogoutCleanupTombstone.mockImplementation(async () => {
      await readGate;
      return makeTombstone();
    });
    trpcMock.revokeDeviceSessionById.mutate.mockResolvedValue({ outcome: 'revoked' });
    notificationsMock.getDevicePushTokenOutcome.mockResolvedValue({ kind: 'none' });

    const first = attemptLogoutReconciliation('u1');
    const second = attemptLogoutReconciliation('u1');

    expect(await second).toEqual({ kind: 'in-flight' });
    gate.release?.();
    const firstOutcome = await first;
    expect(firstOutcome.kind).toBe('attempted');
  });

  it('regression: retains the tombstone when a newer tombstone replaced it during the attempt', async () => {
    cleanupMock.readLogoutCleanupTombstone
      .mockResolvedValueOnce(makeTombstone())
      .mockResolvedValueOnce(makeTombstone({ deviceSessionId: 'newer-session' }));
    trpcMock.revokeDeviceSessionById.mutate.mockResolvedValue({ outcome: 'revoked' });
    notificationsMock.getDevicePushTokenOutcome.mockResolvedValue({ kind: 'none' });

    const outcome = await attemptLogoutReconciliation('u1');

    // The attempt completed its remote parts, but the sign-out cleanup that
    // ran meanwhile wrote a newer tombstone: the stale attempt must not
    // delete it.
    expect(outcome).toEqual({ kind: 'attempted', tombstoneDeleted: false });
    expect(cleanupMock.deleteLogoutCleanupTombstone).not.toHaveBeenCalled();
  });

  it('regression: retains the tombstone when the auth epoch moves during the attempt', async () => {
    cleanupMock.readLogoutCleanupTombstone.mockResolvedValue(makeTombstone());
    const gate = { release: null as (() => void) | null };
    const revokeGate = new Promise<void>(resolve => {
      gate.release = resolve;
    });
    trpcMock.revokeDeviceSessionById.mutate.mockImplementation(async () => {
      await revokeGate;
      return { outcome: 'revoked' };
    });
    notificationsMock.getDevicePushTokenOutcome.mockResolvedValue({ kind: 'none' });

    const attempt = attemptLogoutReconciliation('u1');
    await vi.waitFor(() => {
      expect(trpcMock.revokeDeviceSessionById.mutate).toHaveBeenCalled();
    });

    // A sign-out (or sign-in) advanced the epoch while the attempt was in
    // flight: the sign-out fence must stop the stale deletion.
    bumpAuthEpoch();
    gate.release?.();

    const outcome = await attempt;

    expect(outcome).toEqual({ kind: 'attempted', tombstoneDeleted: false });
    expect(cleanupMock.deleteLogoutCleanupTombstone).not.toHaveBeenCalled();
  });

  it('regression: a tombstone deletion rejection is retained and does not reject the attempt', async () => {
    cleanupMock.readLogoutCleanupTombstone.mockResolvedValue(makeTombstone());
    trpcMock.revokeDeviceSessionById.mutate.mockResolvedValue({ outcome: 'revoked' });
    notificationsMock.getDevicePushTokenOutcome.mockResolvedValue({ kind: 'none' });
    cleanupMock.deleteLogoutCleanupTombstone.mockRejectedValueOnce(new Error('secure store down'));

    // Resolves (never rejects): the mount invokes the attempt with `void` and
    // no rejection handler, so a rejection here would be unhandled.
    const outcome = await attemptLogoutReconciliation('u1');

    expect(outcome).toEqual({ kind: 'attempted', tombstoneDeleted: false });
  });

  it('regression: retains an expired tombstone when its deletion rejects', async () => {
    cleanupMock.readLogoutCleanupTombstone.mockResolvedValue(
      makeTombstone({ failedAt: Date.now() - TOMBSTONE_MAX_AGE_MS - DAY_MS })
    );
    cleanupMock.deleteLogoutCleanupTombstone.mockRejectedValueOnce(new Error('secure store down'));

    const outcome = await attemptLogoutReconciliation('u1');

    expect(outcome).toEqual({ kind: 'expired-retained' });
  });

  it('regression: retains an expired tombstone when a newer tombstone replaced it', async () => {
    cleanupMock.readLogoutCleanupTombstone
      .mockResolvedValueOnce(
        makeTombstone({ failedAt: Date.now() - TOMBSTONE_MAX_AGE_MS - DAY_MS })
      )
      .mockResolvedValueOnce(makeTombstone({ deviceSessionId: 'newer-session' }));

    const outcome = await attemptLogoutReconciliation('u1');

    expect(outcome).toEqual({ kind: 'expired-retained' });
    expect(cleanupMock.deleteLogoutCleanupTombstone).not.toHaveBeenCalled();
  });
});
