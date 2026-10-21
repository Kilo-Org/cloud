/* eslint-disable max-lines -- one cohesive logout-cleanup suite: runLogoutCleanup and the account/org-switch activity unregister share the SecureStore and delivery mocks */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map<string, string>();

/* eslint-disable import/first */
// vi.mock is hoisted by Vitest before the real import resolves.
vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn((key: string) => store.get(key) ?? null),
  setItemAsync: vi.fn((key: string, value: string) => {
    store.set(key, value);
  }),
  deleteItemAsync: vi.fn((key: string) => {
    store.delete(key);
  }),
}));

vi.mock('@sentry/react-native', () => ({ captureException: vi.fn() }));

const trpcMock = vi.hoisted(() => ({
  revokeCurrentDeviceSession: { mutate: vi.fn() },
  unregisterPushToken: { mutate: vi.fn() },
  unregisterActivityToken: { mutate: vi.fn() },
}));

const deliveryMock = vi.hoisted(() => ({
  registerTokens: vi.fn(),
  unregisterTokens: vi.fn(),
}));

vi.mock('@/lib/trpc', () => ({
  trpcClient: { user: trpcMock },
}));

vi.mock('@/lib/glanceable/sink-registry', () => ({
  getGlanceableDelivery: () => deliveryMock,
}));

vi.mock('@/lib/notifications', () => ({
  emitNotificationTokenUpdated: vi.fn(),
  getDevicePushTokenOutcome: vi.fn(),
}));

vi.mock('@/lib/auth/token-owner', () => ({
  getActiveToken: vi.fn(),
}));

// The cleanup reads the cached user id from the read cache, which calls the
// encrypted-kv module; the mock keeps the native SQLCipher chain out of this
// node suite.
vi.mock('@/lib/persist/encrypted-kv', () => ({
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn(),
  clearScope: vi.fn(),
  clearScopePrefix: vi.fn(),
}));

import {
  type LogoutCleanupRecord,
  readLogoutCleanupRecords,
  runLogoutCleanup,
  unregisterActivityTokensAndTombstone,
} from '@/lib/auth/logout-cleanup';
import {
  attemptLogoutReconciliation,
  hasPendingActivityUnregister,
  resetLogoutReconciliationForTests,
} from '@/lib/auth/logout-reconciliation';
import { getDevicePushTokenOutcome } from '@/lib/notifications';
import { getActiveToken } from '@/lib/auth/token-owner';
import { queryClient } from '@/lib/query-client';
import { LOGOUT_CLEANUP_TOMBSTONE_KEY } from '@/lib/storage-keys';
/* eslint-enable import/first */

const GET_ME_QUERY_KEY: readonly unknown[] = [['user', 'getMe'], { type: 'query' }];

/** Records written by these tests are fresh, so reconciliation processes them. */
const RECENT_FAILED_AT = Date.now();

function base64url(input: string): string {
  return btoa(input).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function makeToken(payload: unknown): string {
  return `${base64url('{"alg":"none"}')}.${base64url(JSON.stringify(payload))}.signature`;
}

const TOKEN_WITH_SESSION = makeToken({ sub: 'u1' });

function seedUser(userId: string | null): void {
  if (userId === null) {
    queryClient.removeQueries({ queryKey: GET_ME_QUERY_KEY });
  } else {
    queryClient.setQueryData(GET_ME_QUERY_KEY, { id: userId });
  }
}

function makeRecord(overrides: Partial<LogoutCleanupRecord> = {}): LogoutCleanupRecord {
  return {
    userId: 'u1',
    pushTokens: [],
    pushLookupPending: false,
    needsActivityUnregister: false,
    activityTokens: [],
    failedAt: RECENT_FAILED_AT,
    ...overrides,
  };
}

function seedRecords(records: LogoutCleanupRecord[]): void {
  store.set(LOGOUT_CLEANUP_TOMBSTONE_KEY, JSON.stringify({ version: 2, records }));
}

async function storedRecordFor(owner: string | null): Promise<LogoutCleanupRecord | undefined> {
  const records = await readLogoutCleanupRecords();
  return records.find(record => record.userId === owner);
}

function pushOutcome(kind: 'token' | 'none' | 'lookup-failed', token?: string): void {
  vi.mocked(getDevicePushTokenOutcome).mockResolvedValue(
    kind === 'token' ? { kind: 'token', token: token ?? 'push-1' } : { kind }
  );
}

describe('runLogoutCleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.clear();
    vi.mocked(getActiveToken).mockReturnValue({
      token: TOKEN_WITH_SESSION,
      expiresAtMs: null,
    });
    seedUser('u1');
    deliveryMock.unregisterTokens.mockResolvedValue({ ok: true, tokens: [] });
  });

  it('revokes the session and unregisters the token, then stores no record on full success', async () => {
    store.set(LOGOUT_CLEANUP_TOMBSTONE_KEY, JSON.stringify({ stale: true }));
    pushOutcome('token');
    trpcMock.revokeCurrentDeviceSession.mutate.mockResolvedValue({ outcome: 'revoked' });
    trpcMock.unregisterPushToken.mutate.mockResolvedValue({ success: true });

    await expect(runLogoutCleanup()).resolves.toBeUndefined();

    expect(trpcMock.revokeCurrentDeviceSession.mutate).toHaveBeenCalledTimes(1);
    expect(trpcMock.unregisterPushToken.mutate).toHaveBeenCalledWith({ token: 'push-1' });
    expect(store.has(LOGOUT_CLEANUP_TOMBSTONE_KEY)).toBe(false);
  });

  it('unregisters activity tokens before the revoke ends the session auth', async () => {
    pushOutcome('none');
    const calls: string[] = [];
    deliveryMock.unregisterTokens.mockImplementation(async () => {
      calls.push('activity');
      await Promise.resolve();
      return { ok: true, tokens: ['activity-1'] };
    });
    trpcMock.revokeCurrentDeviceSession.mutate.mockImplementation(async () => {
      calls.push('revoke');
      await Promise.resolve();
      return { outcome: 'revoked' };
    });

    await runLogoutCleanup();

    expect(calls).toEqual(['activity', 'revoke']);
  });

  it('treats a fulfilled no_identifiable_session revoke as done', async () => {
    pushOutcome('none');
    trpcMock.revokeCurrentDeviceSession.mutate.mockResolvedValue({
      outcome: 'no_identifiable_session',
    });

    await runLogoutCleanup();

    // No unregister call for a permission-denied device; the fulfilled revoke
    // means nothing is outstanding.
    expect(trpcMock.unregisterPushToken.mutate).not.toHaveBeenCalled();
    expect(store.has(LOGOUT_CLEANUP_TOMBSTONE_KEY)).toBe(false);
  });

  it('records the push token when the unregister rejects', async () => {
    pushOutcome('token');
    trpcMock.revokeCurrentDeviceSession.mutate.mockRejectedValue(new Error('network down'));
    trpcMock.unregisterPushToken.mutate.mockRejectedValue(new Error('server 500'));

    await runLogoutCleanup();

    expect(await storedRecordFor('u1')).toEqual({
      userId: 'u1',
      pushTokens: ['push-1'],
      pushLookupPending: false,
      needsActivityUnregister: false,
      activityTokens: [],
      failedAt: expect.any(Number),
    });
  });

  it('records the failed activity tokens alongside the push token', async () => {
    pushOutcome('token');
    trpcMock.revokeCurrentDeviceSession.mutate.mockResolvedValue({ outcome: 'revoked' });
    trpcMock.unregisterPushToken.mutate.mockRejectedValue(new Error('server 500'));
    deliveryMock.unregisterTokens.mockResolvedValue({
      ok: false,
      tokens: ['activity-token-1'],
    });

    await runLogoutCleanup();

    expect(await storedRecordFor('u1')).toMatchObject({
      userId: 'u1',
      pushTokens: ['push-1'],
      needsActivityUnregister: true,
      activityTokens: ['activity-token-1'],
    });
  });

  it('treats a NOT_FOUND revoke rejection as done', async () => {
    pushOutcome('token');
    trpcMock.revokeCurrentDeviceSession.mutate.mockRejectedValue({ data: { code: 'NOT_FOUND' } });
    trpcMock.unregisterPushToken.mutate.mockResolvedValue({ success: true });

    await runLogoutCleanup();

    // Nothing outstanding: no record is stored.
    expect(store.has(LOGOUT_CLEANUP_TOMBSTONE_KEY)).toBe(false);
  });

  it('records a lookup-failed push outcome as pending with no token value', async () => {
    pushOutcome('lookup-failed');
    trpcMock.revokeCurrentDeviceSession.mutate.mockResolvedValue({ outcome: 'revoked' });

    await runLogoutCleanup();

    expect(trpcMock.unregisterPushToken.mutate).not.toHaveBeenCalled();
    expect(await storedRecordFor('u1')).toMatchObject({
      pushLookupPending: true,
      pushTokens: [],
    });
  });

  it('never calls the unregister for a permission-denied device', async () => {
    pushOutcome('none');
    trpcMock.revokeCurrentDeviceSession.mutate.mockResolvedValue({ outcome: 'revoked' });

    await runLogoutCleanup();

    expect(trpcMock.unregisterPushToken.mutate).not.toHaveBeenCalled();
    expect(store.has(LOGOUT_CLEANUP_TOMBSTONE_KEY)).toBe(false);
  });

  it('awaits the activity unregister and records its failed tokens', async () => {
    pushOutcome('none');
    trpcMock.revokeCurrentDeviceSession.mutate.mockResolvedValue({ outcome: 'revoked' });
    deliveryMock.unregisterTokens.mockResolvedValue({
      ok: false,
      tokens: ['activity-token-1', 'activity-token-2'],
    });

    await runLogoutCleanup();

    expect(deliveryMock.unregisterTokens).toHaveBeenCalledTimes(1);
    expect(await storedRecordFor('u1')).toMatchObject({
      pushTokens: [],
      needsActivityUnregister: true,
      activityTokens: ['activity-token-1', 'activity-token-2'],
    });
  });

  it('does not write the record until the activity unregister settles', async () => {
    pushOutcome('none');
    trpcMock.revokeCurrentDeviceSession.mutate.mockResolvedValue({ outcome: 'revoked' });
    const gate = { release: null as (() => void) | null };
    const unregisterGate = new Promise<void>(resolve => {
      gate.release = resolve;
    });
    deliveryMock.unregisterTokens.mockImplementation(async () => {
      await unregisterGate;
      return { ok: false, tokens: ['activity-token-1'] };
    });

    const run = runLogoutCleanup();
    // Flush microtasks and a macrotask: the activity unregister is still in
    // flight, so the record must not be written yet.
    await new Promise<void>(resolve => {
      setTimeout(resolve, 0);
    });
    expect(store.has(LOGOUT_CLEANUP_TOMBSTONE_KEY)).toBe(false);

    gate.release?.();
    await run;

    expect(await storedRecordFor('u1')).toMatchObject({
      needsActivityUnregister: true,
      activityTokens: ['activity-token-1'],
    });
  });

  it('still resolves when a record write fails and reports it to Sentry', async () => {
    pushOutcome('token');
    trpcMock.revokeCurrentDeviceSession.mutate.mockRejectedValue(new Error('network down'));
    trpcMock.unregisterPushToken.mutate.mockRejectedValue(new Error('server 500'));
    const { captureException } = await import('@sentry/react-native');

    store.clear();
    const { setItemAsync } = await import('expo-secure-store');
    vi.mocked(setItemAsync).mockRejectedValueOnce(new Error('secure store down'));

    await expect(runLogoutCleanup()).resolves.toBeUndefined();
    expect(captureException).toHaveBeenCalledWith(expect.any(Error), {
      tags: { 'error.subsystem': 'auth', 'error.operation': 'write_logout_tombstone' },
    });
  });

  it('never throws when the push outcome lookup itself throws', async () => {
    vi.mocked(getDevicePushTokenOutcome).mockRejectedValue(new Error('native error'));
    trpcMock.revokeCurrentDeviceSession.mutate.mockResolvedValue({ outcome: 'revoked' });

    await expect(runLogoutCleanup()).resolves.toBeUndefined();

    // The failed lookup is treated as outstanding so reconciliation re-reads.
    expect(await storedRecordFor('u1')).toMatchObject({
      pushLookupPending: true,
      pushTokens: [],
    });
  });

  it('merges new obligations into this account’s earlier pending record', async () => {
    seedRecords([
      makeRecord({
        userId: 'u1',
        pushTokens: ['earlier-push'],
        needsActivityUnregister: true,
        activityTokens: ['earlier-activity'],
      }),
    ]);
    pushOutcome('token', 'push-1');
    trpcMock.revokeCurrentDeviceSession.mutate.mockResolvedValue({ outcome: 'revoked' });
    trpcMock.unregisterPushToken.mutate.mockRejectedValue(new Error('server 500'));
    deliveryMock.unregisterTokens.mockResolvedValue({ ok: false, tokens: ['new-activity'] });

    await runLogoutCleanup();

    expect(await storedRecordFor('u1')).toMatchObject({
      userId: 'u1',
      pushTokens: ['earlier-push', 'push-1'],
      needsActivityUnregister: true,
      activityTokens: ['earlier-activity', 'new-activity'],
    });
  });

  it('keeps an earlier pending obligation when this logout completes its own push unregister', async () => {
    seedRecords([
      makeRecord({
        userId: 'u1',
        pushTokens: ['push-1', 'earlier-push'],
        needsActivityUnregister: true,
        activityTokens: ['earlier-activity'],
      }),
    ]);
    pushOutcome('token', 'push-1');
    trpcMock.revokeCurrentDeviceSession.mutate.mockResolvedValue({ outcome: 'revoked' });
    trpcMock.unregisterPushToken.mutate.mockResolvedValue({ success: true });

    await runLogoutCleanup();

    // `push-1` was just unregistered; the earlier token and the pending
    // activity tokens still need a retry, so the record stays.
    expect(await storedRecordFor('u1')).toMatchObject({
      userId: 'u1',
      pushTokens: ['earlier-push'],
      needsActivityUnregister: true,
      activityTokens: ['earlier-activity'],
    });
  });

  it('keeps a pending record of a different account on a successful logout', async () => {
    seedRecords([
      makeRecord({ userId: 'u1', pushTokens: ['push-a'], needsActivityUnregister: true }),
    ]);
    seedUser('u2');
    pushOutcome('token', 'push-b');
    trpcMock.revokeCurrentDeviceSession.mutate.mockResolvedValue({ outcome: 'revoked' });
    trpcMock.unregisterPushToken.mutate.mockResolvedValue({ success: true });

    await runLogoutCleanup();

    expect(await storedRecordFor('u1')).toMatchObject({
      userId: 'u1',
      pushTokens: ['push-a'],
      needsActivityUnregister: true,
    });
    expect(await storedRecordFor('u2')).toBeUndefined();
  });

  it('keeps a pending record of a different account on a failed logout', async () => {
    seedRecords([makeRecord({ userId: 'u1', pushTokens: ['push-a'] })]);
    seedUser('u2');
    pushOutcome('token', 'push-b');
    trpcMock.revokeCurrentDeviceSession.mutate.mockResolvedValue({ outcome: 'revoked' });
    trpcMock.unregisterPushToken.mutate.mockRejectedValue(new Error('server 500'));

    await runLogoutCleanup();

    expect(await storedRecordFor('u1')).toMatchObject({ userId: 'u1', pushTokens: ['push-a'] });
    expect(await storedRecordFor('u2')).toMatchObject({ userId: 'u2', pushTokens: ['push-b'] });
  });

  // An omitted userId must not be read as `undefined` (which would become a
  // different-account skip), and a non-finite failedAt must not survive: an
  // invalid record is discarded as absent.
  it.each([
    ['omits every required field', { deviceSessionId: 'session-1' }, []],
    [
      'has a wrong field type',
      { userId: 'u1', pushToken: null, needsPushUnregister: 'yes', failedAt: 1_700_000_000_000 },
      [],
    ],
    [
      'has a non-numeric failedAt',
      { userId: null, pushToken: null, needsPushUnregister: false, failedAt: 'soon' },
      [],
    ],
    [
      'has a null failedAt (JSON.stringify writes a non-finite number as null)',
      { userId: null, pushToken: null, needsPushUnregister: false, failedAt: Infinity },
      [],
    ],
    [
      'is a valid record of the previous shape',
      { userId: 'u1', pushToken: 'push-1', needsPushUnregister: true, failedAt: 1_700_000_000_000 },
      [
        {
          userId: 'u1',
          pushTokens: ['push-1'],
          pushLookupPending: false,
          needsActivityUnregister: false,
          activityTokens: [],
          failedAt: 1_700_000_000_000,
        },
      ],
    ],
    [
      'is a previous-shape record with an unknown identity',
      { userId: null, pushToken: null, needsPushUnregister: true, failedAt: 1_700_000_000_000 },
      [
        {
          userId: null,
          pushTokens: [],
          pushLookupPending: true,
          needsActivityUnregister: false,
          activityTokens: [],
          failedAt: 1_700_000_000_000,
        },
      ],
    ],
  ])('reads a persisted record list that %s', async (_label, persisted, expected) => {
    store.set(LOGOUT_CLEANUP_TOMBSTONE_KEY, JSON.stringify(persisted));

    await expect(readLogoutCleanupRecords()).resolves.toEqual(expected);
  });

  it('migrates a previous-shape record when the list is next written', async () => {
    store.set(
      LOGOUT_CLEANUP_TOMBSTONE_KEY,
      JSON.stringify({ userId: 'u2', pushToken: 'push-b', needsPushUnregister: true, failedAt: 1 })
    );
    seedUser('u1');
    pushOutcome('token', 'push-1');
    trpcMock.revokeCurrentDeviceSession.mutate.mockResolvedValue({ outcome: 'revoked' });
    trpcMock.unregisterPushToken.mutate.mockRejectedValue(new Error('server 500'));

    await runLogoutCleanup();

    expect(JSON.parse(store.get(LOGOUT_CLEANUP_TOMBSTONE_KEY) ?? '{}')).toMatchObject({
      version: 2,
      records: [
        { userId: 'u2', pushTokens: ['push-b'] },
        { userId: 'u1', pushTokens: ['push-1'] },
      ],
    });
  });

  it('keeps one record per account when the same account logs out twice', async () => {
    pushOutcome('token', 'push-1');
    trpcMock.revokeCurrentDeviceSession.mutate.mockResolvedValue({ outcome: 'revoked' });
    trpcMock.unregisterPushToken.mutate.mockRejectedValue(new Error('server 500'));

    await runLogoutCleanup();
    await runLogoutCleanup();

    await expect(readLogoutCleanupRecords()).resolves.toMatchObject([
      { userId: 'u1', pushTokens: ['push-1'] },
    ]);
  });
});

describe('unregisterActivityTokensAndTombstone', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetLogoutReconciliationForTests();
    store.clear();
    seedUser('u1');
    deliveryMock.unregisterTokens.mockResolvedValue({ ok: true, tokens: [] });
  });

  it('unregisters the activity tokens and writes no record on success', async () => {
    deliveryMock.unregisterTokens.mockResolvedValue({ ok: true, tokens: ['a1', 'a2'] });

    await expect(unregisterActivityTokensAndTombstone()).resolves.toBeUndefined();

    expect(deliveryMock.unregisterTokens).toHaveBeenCalledTimes(1);
    expect(store.has(LOGOUT_CLEANUP_TOMBSTONE_KEY)).toBe(false);
  });

  it('records the failed activity tokens when the unregister fails', async () => {
    deliveryMock.unregisterTokens.mockResolvedValue({
      ok: false,
      tokens: ['activity-token-1', 'activity-token-2'],
    });

    await unregisterActivityTokensAndTombstone();

    expect(await storedRecordFor('u1')).toMatchObject({
      userId: 'u1',
      pushTokens: [],
      needsActivityUnregister: true,
      activityTokens: ['activity-token-1', 'activity-token-2'],
    });
  });

  it('retains scope delivery and records only the failed ended activity', async () => {
    const rows = new Set(['scope-token', 'ended-token']);
    deliveryMock.unregisterTokens.mockImplementation(async (lifetime: 'scope' | 'activity') => {
      await Promise.resolve();
      if (lifetime !== 'activity') {
        rows.delete('scope-token');
      }
      return { ok: false, tokens: ['ended-token'] };
    });

    await unregisterActivityTokensAndTombstone('activity');

    expect(rows).toEqual(new Set(['scope-token', 'ended-token']));
    expect(await storedRecordFor('u1')).toMatchObject({
      userId: 'u1',
      needsActivityUnregister: true,
      activityTokens: ['ended-token'],
    });
  });

  it('merges into the pending record of this account when logout follows a failed activity end', async () => {
    const { setItemAsync } = await import('expo-secure-store');
    const writing = Promise.withResolvers<undefined>();
    const writeGate = Promise.withResolvers<undefined>();
    vi.mocked(setItemAsync).mockImplementationOnce(async (key, value) => {
      writing.resolve(undefined);
      await writeGate.promise;
      store.set(key, value);
    });
    deliveryMock.unregisterTokens
      .mockResolvedValueOnce({ ok: false, tokens: ['ended-token'] })
      .mockResolvedValue({ ok: true, tokens: [] });
    pushOutcome('none');
    trpcMock.revokeCurrentDeviceSession.mutate.mockResolvedValue({ outcome: 'revoked' });

    const activityEnd = unregisterActivityTokensAndTombstone('activity');
    await writing.promise;
    const logout = runLogoutCleanup();
    await new Promise<void>(resolve => {
      setTimeout(resolve, 0);
    });
    writeGate.resolve(undefined);
    await Promise.all([activityEnd, logout]);

    // The failed activity token is still owed, so logout keeps it pending.
    expect(await storedRecordFor('u1')).toMatchObject({
      userId: 'u1',
      needsActivityUnregister: true,
      activityTokens: ['ended-token'],
    });
  });

  it('leaves an existing pending push unregister of this account untouched on success', async () => {
    seedRecords([makeRecord({ userId: 'u1', pushTokens: ['push-1'] })]);
    deliveryMock.unregisterTokens.mockResolvedValue({ ok: true, tokens: ['a1'] });

    await unregisterActivityTokensAndTombstone();

    expect(await storedRecordFor('u1')).toMatchObject({
      userId: 'u1',
      pushTokens: ['push-1'],
      needsActivityUnregister: false,
    });
  });

  it('preserves this account’s pending push tokens and failed activity tokens', async () => {
    seedRecords([
      makeRecord({
        userId: 'u1',
        pushTokens: ['push-1', 'push-earlier'],
        needsActivityUnregister: true,
        activityTokens: ['earlier-activity', 'shared-activity'],
      }),
    ]);
    deliveryMock.unregisterTokens.mockResolvedValue({
      ok: false,
      tokens: ['shared-activity', 'new-activity'],
    });

    await unregisterActivityTokensAndTombstone();

    expect(await storedRecordFor('u1')).toMatchObject({
      userId: 'u1',
      pushTokens: ['push-1', 'push-earlier'],
      needsActivityUnregister: true,
      activityTokens: ['earlier-activity', 'shared-activity', 'new-activity'],
    });
  });

  it('keeps the pending record of a different account unchanged', async () => {
    seedRecords([
      makeRecord({
        userId: 'u2',
        pushTokens: ['other-push'],
        needsActivityUnregister: true,
        activityTokens: ['other-activity'],
      }),
    ]);
    deliveryMock.unregisterTokens.mockResolvedValue({ ok: false, tokens: ['current-activity'] });

    await unregisterActivityTokensAndTombstone();

    expect(await storedRecordFor('u2')).toMatchObject({
      userId: 'u2',
      pushTokens: ['other-push'],
      needsActivityUnregister: true,
      activityTokens: ['other-activity'],
    });
    expect(await storedRecordFor('u1')).toMatchObject({
      userId: 'u1',
      pushTokens: [],
      needsActivityUnregister: true,
      activityTokens: ['current-activity'],
    });
  });

  it('waits for overlapping cleanup writes before allowing the registration guard to settle', async () => {
    const { setItemAsync } = await import('expo-secure-store');
    const writeGate = Promise.withResolvers<undefined>();
    let writing = false;
    vi.mocked(setItemAsync).mockImplementationOnce(async (key, value) => {
      writing = true;
      await writeGate.promise;
      store.set(key, value);
    });
    deliveryMock.unregisterTokens
      .mockResolvedValueOnce({ ok: false, tokens: ['first-activity'] })
      .mockResolvedValueOnce({ ok: false, tokens: ['second-activity'] });

    const first = unregisterActivityTokensAndTombstone();
    await vi.waitFor(() => {
      expect(writing).toBe(true);
    });
    const second = unregisterActivityTokensAndTombstone();
    let pending: boolean | undefined = undefined;
    const guard = (async () => {
      pending = await hasPendingActivityUnregister('u1');
    })();
    await new Promise<void>(resolve => {
      setTimeout(resolve, 0);
    });
    const pendingBeforeWrite = pending;
    writeGate.resolve(undefined);
    await Promise.all([first, second, guard]);

    expect(pendingBeforeWrite).toBeUndefined();
    expect(pending).toBe(true);
    expect(await storedRecordFor('u1')).toMatchObject({
      needsActivityUnregister: true,
      activityTokens: ['first-activity', 'second-activity'],
    });
  });

  it.each([
    { path: 'successful deletion', pushSucceeds: true, activityTokens: [] },
    { path: 'partial-success rewrite', pushSucceeds: false, activityTokens: ['earlier-activity'] },
  ])(
    'preserves later scope cleanup after reconciliation $path',
    async ({ pushSucceeds, activityTokens }) => {
      seedRecords([
        makeRecord({
          userId: 'u1',
          pushTokens: ['push-1'],
          needsActivityUnregister: activityTokens.length > 0,
          activityTokens,
        }),
      ]);
      const pushStarted = Promise.withResolvers<undefined>();
      const pushGate = Promise.withResolvers<undefined>();
      trpcMock.unregisterPushToken.mutate.mockImplementationOnce(async () => {
        pushStarted.resolve(undefined);
        await pushGate.promise;
        if (!pushSucceeds) {
          throw new Error('network down');
        }
        return { success: true };
      });
      trpcMock.unregisterActivityToken.mutate.mockResolvedValue({ success: true });
      deliveryMock.unregisterTokens.mockResolvedValue({ ok: false, tokens: ['later-activity'] });

      // Keep the auth epoch unchanged, as an organization switch does.
      const attempt = attemptLogoutReconciliation('u1');
      await pushStarted.promise;
      const cleanup = unregisterActivityTokensAndTombstone();
      // Let the failed scope cleanup reach its record merge while the
      // reconciliation still holds the older record.
      await new Promise<void>(resolve => {
        setTimeout(resolve, 0);
      });
      pushGate.resolve(undefined);
      await Promise.all([attempt, cleanup]);

      expect(await storedRecordFor('u1')).toMatchObject({
        userId: 'u1',
        needsActivityUnregister: true,
        activityTokens: ['later-activity'],
      });
      if (!pushSucceeds) {
        expect(await storedRecordFor('u1')).toMatchObject({
          pushTokens: ['push-1'],
        });
      }
      expect(await attemptLogoutReconciliation('u1')).toEqual({ kind: 'spacing-skipped' });
      await expect(hasPendingActivityUnregister('u1')).resolves.toBe(true);
    }
  );

  it('never throws when the unregister itself rejects', async () => {
    deliveryMock.unregisterTokens.mockRejectedValue(new Error('network down'));

    await expect(unregisterActivityTokensAndTombstone()).resolves.toBeUndefined();
    expect(store.has(LOGOUT_CLEANUP_TOMBSTONE_KEY)).toBe(false);
  });
});
