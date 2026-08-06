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
    pushToken: 'push-stored',
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
    expect(trpcMock.unregisterPushToken.mutate).not.toHaveBeenCalled();
    expect(trpcMock.unregisterPushToken.mutate).not.toHaveBeenCalled();
  });

  it('discards a tombstone older than 30 days without a network call', async () => {
    cleanupMock.readLogoutCleanupTombstone.mockResolvedValue(
      makeTombstone({ failedAt: Date.now() - TOMBSTONE_MAX_AGE_MS - DAY_MS })
    );

    const outcome = await attemptLogoutReconciliation('u1');

    expect(outcome).toEqual({ kind: 'expired-discarded' });
    expect(cleanupMock.deleteLogoutCleanupTombstone).toHaveBeenCalledTimes(1);
    expect(trpcMock.unregisterPushToken.mutate).not.toHaveBeenCalled();
    expect(trpcMock.unregisterPushToken.mutate).not.toHaveBeenCalled();
  });

  it('leaves a different known user tombstone untouched', async () => {
    cleanupMock.readLogoutCleanupTombstone.mockResolvedValue(makeTombstone({ userId: 'u1' }));

    const outcome = await attemptLogoutReconciliation('u2');

    expect(outcome).toEqual({ kind: 'different-user-skipped' });
    expect(cleanupMock.deleteLogoutCleanupTombstone).not.toHaveBeenCalled();
    expect(trpcMock.unregisterPushToken.mutate).not.toHaveBeenCalled();
  });

  it('re-reads the device token for the owner and deletes the tombstone', async () => {
    cleanupMock.readLogoutCleanupTombstone.mockResolvedValue(makeTombstone({ pushToken: null }));
    notificationsMock.getDevicePushTokenOutcome.mockResolvedValue({
      kind: 'token',
      token: 'push-9',
    });
    trpcMock.unregisterPushToken.mutate.mockResolvedValue({ success: true });

    const outcome = await attemptLogoutReconciliation('u1');

    expect(outcome).toEqual({ kind: 'attempted', tombstoneDeleted: true });
    expect(trpcMock.unregisterPushToken.mutate).toHaveBeenCalledWith({ token: 'push-9' });
    expect(cleanupMock.deleteLogoutCleanupTombstone).toHaveBeenCalledTimes(1);
  });

  it('uses the stored push token when one exists instead of re-reading the device', async () => {
    cleanupMock.readLogoutCleanupTombstone.mockResolvedValue(
      makeTombstone({ pushToken: 'push-stored' })
    );
    trpcMock.unregisterPushToken.mutate.mockResolvedValue({ success: true });

    const outcome = await attemptLogoutReconciliation('u1');

    expect(outcome).toEqual({ kind: 'attempted', tombstoneDeleted: true });
    expect(trpcMock.unregisterPushToken.mutate).toHaveBeenCalledWith({ token: 'push-stored' });
    expect(notificationsMock.getDevicePushTokenOutcome).not.toHaveBeenCalled();
  });

  it('treats a re-read none outcome as terminal for the push part', async () => {
    cleanupMock.readLogoutCleanupTombstone.mockResolvedValue(makeTombstone({ pushToken: null }));
    notificationsMock.getDevicePushTokenOutcome.mockResolvedValue({ kind: 'none' });

    const outcome = await attemptLogoutReconciliation('u1');

    expect(outcome).toEqual({ kind: 'attempted', tombstoneDeleted: true });
    expect(trpcMock.unregisterPushToken.mutate).not.toHaveBeenCalled();
  });

  it('keeps the push part when the re-read lookup fails', async () => {
    cleanupMock.readLogoutCleanupTombstone.mockResolvedValue(makeTombstone({ pushToken: null }));
    notificationsMock.getDevicePushTokenOutcome.mockResolvedValue({ kind: 'lookup-failed' });

    const outcome = await attemptLogoutReconciliation('u1');

    expect(outcome).toEqual({ kind: 'attempted', tombstoneDeleted: false });
    expect(trpcMock.unregisterPushToken.mutate).not.toHaveBeenCalled();
  });

  it('keeps the push part when the unregister rejects', async () => {
    cleanupMock.readLogoutCleanupTombstone.mockResolvedValue(
      makeTombstone({ pushToken: 'push-stored' })
    );
    trpcMock.unregisterPushToken.mutate.mockRejectedValue(new Error('server 500'));

    const outcome = await attemptLogoutReconciliation('u1');

    expect(outcome).toEqual({ kind: 'attempted', tombstoneDeleted: false });
  });

  it('skips a second attempt within the 60 s spacing window', async () => {
    cleanupMock.readLogoutCleanupTombstone.mockResolvedValue(makeTombstone());
    trpcMock.unregisterPushToken.mutate.mockResolvedValue({ success: true });
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
    trpcMock.unregisterPushToken.mutate.mockResolvedValue({ success: true });
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
      .mockResolvedValueOnce(makeTombstone({ pushToken: 'push-newer' }));
    trpcMock.unregisterPushToken.mutate.mockResolvedValue({ success: true });
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
    const unregisterGate = new Promise<void>(resolve => {
      gate.release = resolve;
    });
    trpcMock.unregisterPushToken.mutate.mockImplementation(async () => {
      await unregisterGate;
      return { success: true };
    });

    const attempt = attemptLogoutReconciliation('u1');
    await vi.waitFor(() => {
      expect(trpcMock.unregisterPushToken.mutate).toHaveBeenCalled();
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
    trpcMock.unregisterPushToken.mutate.mockResolvedValue({ success: true });
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
      .mockResolvedValueOnce(makeTombstone({ pushToken: 'push-newer' }));

    const outcome = await attemptLogoutReconciliation('u1');

    expect(outcome).toEqual({ kind: 'expired-retained' });
    expect(cleanupMock.deleteLogoutCleanupTombstone).not.toHaveBeenCalled();
  });
});
