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
}));

vi.mock('@/lib/trpc', () => ({
  trpcClient: { user: trpcMock },
}));

vi.mock('@/lib/notifications', () => ({
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

import { readLogoutCleanupTombstone, runLogoutCleanup } from '@/lib/auth/logout-cleanup';
import { getDevicePushTokenOutcome } from '@/lib/notifications';
import { getActiveToken } from '@/lib/auth/token-owner';
import { queryClient } from '@/lib/query-client';
import { LOGOUT_CLEANUP_TOMBSTONE_KEY } from '@/lib/storage-keys';
/* eslint-enable import/first */

const GET_ME_QUERY_KEY: readonly unknown[] = [['user', 'getMe'], { type: 'query' }];

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
  });

  it('revokes the session and unregisters the token, then deletes any existing tombstone on full success', async () => {
    store.set(LOGOUT_CLEANUP_TOMBSTONE_KEY, JSON.stringify({ stale: true }));
    pushOutcome('token');
    trpcMock.revokeCurrentDeviceSession.mutate.mockResolvedValue({ outcome: 'revoked' });
    trpcMock.unregisterPushToken.mutate.mockResolvedValue({ success: true });

    await expect(runLogoutCleanup()).resolves.toBeUndefined();

    expect(trpcMock.revokeCurrentDeviceSession.mutate).toHaveBeenCalledTimes(1);
    expect(trpcMock.unregisterPushToken.mutate).toHaveBeenCalledWith({ token: 'push-1' });
    expect(store.has(LOGOUT_CLEANUP_TOMBSTONE_KEY)).toBe(false);
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

  it('writes both flags when both remote parts reject', async () => {
    pushOutcome('token');
    trpcMock.revokeCurrentDeviceSession.mutate.mockRejectedValue(new Error('network down'));
    trpcMock.unregisterPushToken.mutate.mockRejectedValue(new Error('server 500'));

    await runLogoutCleanup();

    const tombstone = await readLogoutCleanupTombstone();
    expect(tombstone).toEqual({
      userId: 'u1',
      pushToken: 'push-1',
      needsPushUnregister: true,
      failedAt: expect.any(Number),
    });
  });

  it('writes only the push flag when only the unregister rejects', async () => {
    pushOutcome('token');
    trpcMock.revokeCurrentDeviceSession.mutate.mockResolvedValue({ outcome: 'revoked' });
    trpcMock.unregisterPushToken.mutate.mockRejectedValue(new Error('server 500'));

    await runLogoutCleanup();

    const tombstone = await readLogoutCleanupTombstone();
    expect(tombstone).toMatchObject({
      userId: 'u1',
      pushToken: 'push-1',
      needsPushUnregister: true,
    });
  });

  it('treats a NOT_FOUND revoke rejection as done', async () => {
    pushOutcome('token');
    trpcMock.revokeCurrentDeviceSession.mutate.mockRejectedValue({ data: { code: 'NOT_FOUND' } });
    trpcMock.unregisterPushToken.mutate.mockResolvedValue({ success: true });

    await runLogoutCleanup();

    // Nothing outstanding: the tombstone is deleted, not written.
    expect(store.has(LOGOUT_CLEANUP_TOMBSTONE_KEY)).toBe(false);
  });

  it('records a lookup-failed push outcome as outstanding with pushToken null', async () => {
    pushOutcome('lookup-failed');
    trpcMock.revokeCurrentDeviceSession.mutate.mockResolvedValue({ outcome: 'revoked' });

    await runLogoutCleanup();

    expect(trpcMock.unregisterPushToken.mutate).not.toHaveBeenCalled();
    const tombstone = await readLogoutCleanupTombstone();
    expect(tombstone).toMatchObject({
      needsPushUnregister: true,
      pushToken: null,
    });
  });

  it('never calls the unregister for a permission-denied device', async () => {
    pushOutcome('none');
    trpcMock.revokeCurrentDeviceSession.mutate.mockResolvedValue({ outcome: 'revoked' });

    await runLogoutCleanup();

    expect(trpcMock.unregisterPushToken.mutate).not.toHaveBeenCalled();
    expect(store.has(LOGOUT_CLEANUP_TOMBSTONE_KEY)).toBe(false);
  });

  it('still resolves when a tombstone write fails and reports it to Sentry', async () => {
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
    const tombstone = await readLogoutCleanupTombstone();
    expect(tombstone).toMatchObject({
      needsPushUnregister: true,
      pushToken: null,
    });
  });

  // An omitted userId must not be read as `undefined` (which would become a
  // different-user skip), and a non-finite failedAt must not survive: an
  // invalid record is discarded as absent.
  it.each([
    ['omits every required field', { deviceSessionId: 'session-1' }, null],
    [
      'has a wrong field type',
      { userId: 'u1', pushToken: null, needsPushUnregister: 'yes', failedAt: 1_700_000_000_000 },
      null,
    ],
    [
      'has a non-numeric failedAt',
      { userId: null, pushToken: null, needsPushUnregister: false, failedAt: 'soon' },
      null,
    ],
    [
      'has a null failedAt (JSON.stringify writes a non-finite number as null)',
      { userId: null, pushToken: null, needsPushUnregister: false, failedAt: Infinity },
      null,
    ],
    [
      'is fully valid',
      { userId: 'u1', pushToken: null, needsPushUnregister: false, failedAt: 1_700_000_000_000 },
      { userId: 'u1', pushToken: null, needsPushUnregister: false, failedAt: 1_700_000_000_000 },
    ],
    [
      'is valid with a null userId (identity unknown)',
      { userId: null, pushToken: 'push-1', needsPushUnregister: true, failedAt: 1_700_000_000_000 },
      { userId: null, pushToken: 'push-1', needsPushUnregister: true, failedAt: 1_700_000_000_000 },
    ],
  ])('reads a persisted tombstone that %s', async (_label, persisted, expected) => {
    store.set(LOGOUT_CLEANUP_TOMBSTONE_KEY, JSON.stringify(persisted));

    await expect(readLogoutCleanupTombstone()).resolves.toEqual(expected);
  });
});
