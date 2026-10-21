/* eslint-disable max-lines -- one cohesive reconciliation suite: read/clean/write of the per-account record store shares the same mocks */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type LogoutCleanupRecord } from '@/lib/auth/logout-cleanup';

const cleanupMock = vi.hoisted(() => {
  const readState: { records: LogoutCleanupRecord[]; unreadable: boolean; corrupt: boolean } = {
    records: [],
    unreadable: false,
    corrupt: false,
  };
  return {
    readState,
    defaultStoreRead: async () => {
      await Promise.resolve();
      if (readState.unreadable) {
        return { status: 'unreadable' } as const;
      }
      if (readState.corrupt) {
        return { status: 'corrupt' } as const;
      }
      return { status: 'records', records: readState.records } as const;
    },
    awaitActivityCleanupSettled: vi.fn().mockResolvedValue(undefined),
    readLogoutCleanupStore: vi.fn(),
    writeLogoutCleanupRecords: vi.fn().mockResolvedValue(undefined),
    hasLogoutCleanupObligation: (record: LogoutCleanupRecord) =>
      record.pushLookupPending || record.pushTokens.length > 0 || record.needsActivityUnregister,
  };
});

const trpcMock = vi.hoisted(() => ({
  unregisterPushToken: { mutate: vi.fn() },
  unregisterActivityToken: { mutate: vi.fn() },
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
  hasPendingActivityUnregister,
  resetLogoutReconciliationForTests,
  TOMBSTONE_MAX_AGE_MS,
} from '@/lib/auth/logout-reconciliation';
/* eslint-enable import/first */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Records written by these tests are fresh, so reconciliation processes them. */
const RECENT_FAILED_AT = Date.now();

function makeRecord(overrides: Partial<LogoutCleanupRecord> = {}): LogoutCleanupRecord {
  return {
    userId: 'u1',
    pushTokens: [],
    pushLookupPending: true,
    needsActivityUnregister: false,
    activityTokens: [],
    failedAt: RECENT_FAILED_AT,
    ...overrides,
  };
}

describe('attemptLogoutReconciliation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetLogoutReconciliationForTests();
    cleanupMock.readState.records = [];
    cleanupMock.readState.unreadable = false;
    cleanupMock.readState.corrupt = false;
    cleanupMock.readLogoutCleanupStore.mockImplementation(cleanupMock.defaultStoreRead);
    cleanupMock.writeLogoutCleanupRecords.mockResolvedValue(undefined);
  });

  it('returns no-record and makes no network call when nothing is pending', async () => {
    const outcome = await attemptLogoutReconciliation('u1');

    expect(outcome).toEqual({ kind: 'no-tombstone' });
    expect(trpcMock.unregisterPushToken.mutate).not.toHaveBeenCalled();
  });

  it('leaves an unreadable store untouched without a network call', async () => {
    cleanupMock.readState.unreadable = true;

    const outcome = await attemptLogoutReconciliation('u1');

    // A store that cannot be read must not be rewritten from an empty list.
    expect(outcome).toEqual({ kind: 'unreadable-store' });
    expect(cleanupMock.writeLogoutCleanupRecords).not.toHaveBeenCalled();
    expect(trpcMock.unregisterPushToken.mutate).not.toHaveBeenCalled();
  });

  it('repairs a store payload that is not valid JSON', async () => {
    cleanupMock.readState.corrupt = true;

    const outcome = await attemptLogoutReconciliation('u1');

    // Nothing in an unparseable payload is recoverable, so the attempt
    // replaces it with the empty list instead of retrying it forever.
    expect(outcome).toEqual({ kind: 'corrupt-repaired' });
    expect(cleanupMock.writeLogoutCleanupRecords).toHaveBeenCalledWith([]);
    expect(trpcMock.unregisterPushToken.mutate).not.toHaveBeenCalled();
  });

  it('discards a record older than 30 days without a network call', async () => {
    cleanupMock.readState.records = [
      makeRecord({ failedAt: Date.now() - TOMBSTONE_MAX_AGE_MS - DAY_MS }),
    ];

    const outcome = await attemptLogoutReconciliation('u1');

    expect(outcome).toEqual({ kind: 'expired-discarded' });
    expect(cleanupMock.writeLogoutCleanupRecords).toHaveBeenCalledWith([]);
    expect(trpcMock.unregisterPushToken.mutate).not.toHaveBeenCalled();
  });

  it('retains an expired record when its rewrite rejects', async () => {
    cleanupMock.readState.records = [
      makeRecord({ failedAt: Date.now() - TOMBSTONE_MAX_AGE_MS - DAY_MS }),
    ];
    cleanupMock.writeLogoutCleanupRecords.mockRejectedValueOnce(new Error('secure store down'));

    const outcome = await attemptLogoutReconciliation('u1');

    expect(outcome).toEqual({ kind: 'expired-retained' });
  });

  it('keeps a record of another known account untouched', async () => {
    cleanupMock.readState.records = [
      makeRecord({ userId: 'u1', pushTokens: ['push-stored'], pushLookupPending: false }),
    ];

    const outcome = await attemptLogoutReconciliation('u2');

    // The unregister needs the other account's auth, so this attempt leaves
    // the record for that account and its expiry to settle.
    expect(outcome).toEqual({ kind: 'different-user-retained' });
    expect(cleanupMock.writeLogoutCleanupRecords).not.toHaveBeenCalled();
    expect(trpcMock.unregisterPushToken.mutate).not.toHaveBeenCalled();
  });

  it('purges an expired record of another account', async () => {
    cleanupMock.readState.records = [
      makeRecord({
        userId: 'u1',
        pushTokens: ['push-stored'],
        pushLookupPending: false,
        failedAt: Date.now() - TOMBSTONE_MAX_AGE_MS - DAY_MS,
      }),
    ];

    const outcome = await attemptLogoutReconciliation('u2');

    expect(outcome).toEqual({ kind: 'expired-discarded' });
    expect(cleanupMock.writeLogoutCleanupRecords).toHaveBeenCalledWith([]);
  });

  it('re-reads the device token for the owner and clears the record', async () => {
    cleanupMock.readState.records = [makeRecord({ pushLookupPending: true })];
    notificationsMock.getDevicePushTokenOutcome.mockResolvedValue({
      kind: 'token',
      token: 'push-9',
    });
    trpcMock.unregisterPushToken.mutate.mockResolvedValue({ success: true });

    const outcome = await attemptLogoutReconciliation('u1');

    expect(outcome).toEqual({ kind: 'attempted', tombstoneDeleted: true });
    expect(trpcMock.unregisterPushToken.mutate).toHaveBeenCalledWith({ token: 'push-9' });
    expect(cleanupMock.writeLogoutCleanupRecords).toHaveBeenCalledWith([]);
  });

  it('uses the recorded push tokens instead of re-reading the device', async () => {
    cleanupMock.readState.records = [
      makeRecord({ pushTokens: ['push-stored'], pushLookupPending: false }),
    ];
    trpcMock.unregisterPushToken.mutate.mockResolvedValue({ success: true });

    const outcome = await attemptLogoutReconciliation('u1');

    expect(outcome).toEqual({ kind: 'attempted', tombstoneDeleted: true });
    expect(trpcMock.unregisterPushToken.mutate).toHaveBeenCalledWith({ token: 'push-stored' });
    expect(notificationsMock.getDevicePushTokenOutcome).not.toHaveBeenCalled();
  });

  it('treats a re-read none outcome as terminal for the push part', async () => {
    cleanupMock.readState.records = [makeRecord({ pushLookupPending: true })];
    notificationsMock.getDevicePushTokenOutcome.mockResolvedValue({ kind: 'none' });

    const outcome = await attemptLogoutReconciliation('u1');

    expect(outcome).toEqual({ kind: 'attempted', tombstoneDeleted: true });
    expect(trpcMock.unregisterPushToken.mutate).not.toHaveBeenCalled();
  });

  it('keeps the lookup pending when the re-read lookup fails', async () => {
    cleanupMock.readState.records = [makeRecord({ pushLookupPending: true })];
    notificationsMock.getDevicePushTokenOutcome.mockResolvedValue({ kind: 'lookup-failed' });

    const outcome = await attemptLogoutReconciliation('u1');

    expect(outcome).toEqual({ kind: 'attempted', tombstoneDeleted: false });
    expect(cleanupMock.writeLogoutCleanupRecords).toHaveBeenCalledWith([
      makeRecord({ pushLookupPending: true }),
    ]);
  });

  it('keeps the token that rejects and drops the token that unregistered', async () => {
    cleanupMock.readState.records = [
      makeRecord({ pushTokens: ['push-ok', 'push-failed'], pushLookupPending: false }),
    ];
    trpcMock.unregisterPushToken.mutate.mockImplementation(async ({ token }: { token: string }) => {
      await Promise.resolve();
      if (token === 'push-failed') {
        throw new Error('server 500');
      }
      return { success: true };
    });

    const outcome = await attemptLogoutReconciliation('u1');

    expect(outcome).toEqual({ kind: 'attempted', tombstoneDeleted: false });
    expect(cleanupMock.writeLogoutCleanupRecords).toHaveBeenCalledWith([
      makeRecord({ pushTokens: ['push-failed'], pushLookupPending: false }),
    ]);
  });

  it('unregisters each recorded activity token and clears the record when all succeed', async () => {
    cleanupMock.readState.records = [
      makeRecord({
        pushLookupPending: false,
        needsActivityUnregister: true,
        activityTokens: ['activity-1', 'activity-2'],
      }),
    ];
    trpcMock.unregisterActivityToken.mutate.mockResolvedValue({ success: true });

    const outcome = await attemptLogoutReconciliation('u1');

    expect(outcome).toEqual({ kind: 'attempted', tombstoneDeleted: true });
    expect(trpcMock.unregisterActivityToken.mutate).toHaveBeenCalledWith({ token: 'activity-1' });
    expect(trpcMock.unregisterActivityToken.mutate).toHaveBeenCalledWith({ token: 'activity-2' });
    expect(trpcMock.unregisterPushToken.mutate).not.toHaveBeenCalled();
    expect(cleanupMock.writeLogoutCleanupRecords).toHaveBeenCalledWith([]);
  });

  it('keeps the record when any recorded activity token unregister rejects', async () => {
    cleanupMock.readState.records = [
      makeRecord({
        pushLookupPending: false,
        needsActivityUnregister: true,
        activityTokens: ['activity-1', 'activity-2'],
      }),
    ];
    trpcMock.unregisterActivityToken.mutate
      .mockResolvedValueOnce({ success: true })
      .mockRejectedValueOnce(new Error('server 500'));

    const outcome = await attemptLogoutReconciliation('u1');

    expect(outcome).toEqual({ kind: 'attempted', tombstoneDeleted: false });
    expect(trpcMock.unregisterActivityToken.mutate).toHaveBeenCalledTimes(2);
    expect(cleanupMock.writeLogoutCleanupRecords).toHaveBeenCalledWith([
      makeRecord({
        pushLookupPending: false,
        needsActivityUnregister: true,
        activityTokens: ['activity-1', 'activity-2'],
      }),
    ]);
  });

  it('clears the activity part after success while the push part stays outstanding', async () => {
    const failedAt = Date.now();
    cleanupMock.readState.records = [
      makeRecord({
        pushTokens: ['push-stored'],
        pushLookupPending: false,
        needsActivityUnregister: true,
        activityTokens: ['activity-1'],
        failedAt,
      }),
    ];
    trpcMock.unregisterPushToken.mutate.mockRejectedValue(new Error('server 500'));
    trpcMock.unregisterActivityToken.mutate.mockResolvedValue({ success: true });

    const outcome = await attemptLogoutReconciliation('u1');

    expect(outcome).toEqual({ kind: 'attempted', tombstoneDeleted: false });
    expect(trpcMock.unregisterActivityToken.mutate).toHaveBeenCalledWith({ token: 'activity-1' });
    expect(cleanupMock.writeLogoutCleanupRecords).toHaveBeenCalledWith([
      {
        userId: 'u1',
        pushTokens: ['push-stored'],
        pushLookupPending: false,
        needsActivityUnregister: false,
        activityTokens: [],
        failedAt,
      },
    ]);
  });

  it('reconciles the record of an unknown identity under the signed-in account', async () => {
    cleanupMock.readState.records = [makeRecord({ userId: null, pushLookupPending: true })];
    notificationsMock.getDevicePushTokenOutcome.mockResolvedValue({ kind: 'none' });

    const outcome = await attemptLogoutReconciliation('u1');

    expect(outcome).toEqual({ kind: 'attempted', tombstoneDeleted: true });
    expect(cleanupMock.writeLogoutCleanupRecords).toHaveBeenCalledWith([]);
  });

  it('reconciles its own record and retains the record of another account', async () => {
    cleanupMock.readState.records = [
      makeRecord({
        userId: 'u2',
        pushTokens: ['other-push'],
        pushLookupPending: false,
        needsActivityUnregister: true,
        activityTokens: ['other-activity'],
      }),
      makeRecord({ userId: 'u1', pushLookupPending: true }),
    ];
    notificationsMock.getDevicePushTokenOutcome.mockResolvedValue({ kind: 'none' });

    const outcome = await attemptLogoutReconciliation('u1');

    expect(outcome).toEqual({ kind: 'attempted', tombstoneDeleted: true });
    expect(cleanupMock.writeLogoutCleanupRecords).toHaveBeenCalledWith([
      makeRecord({
        userId: 'u2',
        pushTokens: ['other-push'],
        pushLookupPending: false,
        needsActivityUnregister: true,
        activityTokens: ['other-activity'],
      }),
    ]);
    expect(trpcMock.unregisterPushToken.mutate).not.toHaveBeenCalled();
    expect(trpcMock.unregisterActivityToken.mutate).not.toHaveBeenCalled();
  });

  it('skips a second attempt within the 60 s spacing window', async () => {
    cleanupMock.readState.records = [makeRecord()];
    trpcMock.unregisterPushToken.mutate.mockResolvedValue({ success: true });
    notificationsMock.getDevicePushTokenOutcome.mockResolvedValue({ kind: 'none' });

    const first = await attemptLogoutReconciliation('u1');
    const second = await attemptLogoutReconciliation('u1');

    expect(first.kind).toBe('attempted');
    expect(second).toEqual({ kind: 'spacing-skipped' });
  });

  it('single-flights concurrent attempts', async () => {
    const { promise: readGate, resolve: openReadGate } = Promise.withResolvers<undefined>();
    cleanupMock.readLogoutCleanupStore.mockImplementation(async () => {
      await readGate;
      return { status: 'records' as const, records: [makeRecord()] };
    });
    trpcMock.unregisterPushToken.mutate.mockResolvedValue({ success: true });
    notificationsMock.getDevicePushTokenOutcome.mockResolvedValue({ kind: 'none' });

    const first = attemptLogoutReconciliation('u1');
    const second = attemptLogoutReconciliation('u1');

    expect(await second).toEqual({ kind: 'in-flight' });
    openReadGate(undefined);
    const firstOutcome = await first;
    expect(firstOutcome.kind).toBe('attempted');
  });

  it('regression: retains the record when the auth epoch moves during the attempt', async () => {
    cleanupMock.readState.records = [
      makeRecord({ pushTokens: ['push-1'], pushLookupPending: false }),
    ];
    const { promise: unregisterGate, resolve: openUnregisterGate } =
      Promise.withResolvers<undefined>();
    trpcMock.unregisterPushToken.mutate.mockImplementation(async () => {
      await unregisterGate;
      return { success: true };
    });

    const attempt = attemptLogoutReconciliation('u1');
    await vi.waitFor(() => {
      expect(trpcMock.unregisterPushToken.mutate).toHaveBeenCalled();
    });

    // A sign-out (or sign-in) advanced the epoch while the attempt was in
    // flight: the sign-out fence must stop the stale rewrite.
    bumpAuthEpoch();
    openUnregisterGate(undefined);

    const outcome = await attempt;

    expect(outcome).toEqual({ kind: 'attempted', tombstoneDeleted: false });
    expect(cleanupMock.writeLogoutCleanupRecords).not.toHaveBeenCalled();
  });

  it('regression: a record write rejection is retained and does not reject the attempt', async () => {
    cleanupMock.readState.records = [makeRecord()];
    trpcMock.unregisterPushToken.mutate.mockResolvedValue({ success: true });
    notificationsMock.getDevicePushTokenOutcome.mockResolvedValue({ kind: 'none' });
    cleanupMock.writeLogoutCleanupRecords.mockRejectedValueOnce(new Error('secure store down'));

    // Resolves (never rejects): the mount invokes the attempt with `void` and
    // no rejection handler, so a rejection here would be unhandled.
    const outcome = await attemptLogoutReconciliation('u1');

    expect(outcome).toEqual({ kind: 'attempted', tombstoneDeleted: false });
  });

  it('reports a pending activity unregister while the record still needs it', async () => {
    cleanupMock.readState.records = [
      makeRecord({ needsActivityUnregister: true, activityTokens: ['activity-1'] }),
    ];

    await expect(hasPendingActivityUnregister('u1')).resolves.toBe(true);
  });

  it.each([
    { owner: 'u1', currentUser: 'u2', pending: false },
    { owner: null, currentUser: 'u2', pending: true },
    { owner: 'u1', currentUser: null, pending: true },
  ])(
    'scopes the activity guard to owner $owner and current user $currentUser',
    async ({ owner, currentUser, pending }) => {
      cleanupMock.readState.records = [
        makeRecord({
          userId: owner,
          needsActivityUnregister: true,
          activityTokens: ['activity-1'],
        }),
      ];

      await expect(hasPendingActivityUnregister(currentUser)).resolves.toBe(pending);
    }
  );

  it('does not block a new account when the other record survives and the retry is spacing-skipped', async () => {
    cleanupMock.readState.records = [
      makeRecord({ needsActivityUnregister: true, activityTokens: ['activity-1'] }),
    ];

    await attemptLogoutReconciliation('u2');
    expect(await attemptLogoutReconciliation('u2')).toEqual({ kind: 'spacing-skipped' });
    await expect(hasPendingActivityUnregister('u2')).resolves.toBe(false);
  });

  it('reports no pending activity unregister when the record needs only the push part', async () => {
    cleanupMock.readState.records = [
      makeRecord({ needsActivityUnregister: false, pushLookupPending: true }),
    ];

    await expect(hasPendingActivityUnregister('u1')).resolves.toBe(false);
  });

  it('reports no pending activity unregister when no record exists', async () => {
    await expect(hasPendingActivityUnregister('u1')).resolves.toBe(false);
  });
});
