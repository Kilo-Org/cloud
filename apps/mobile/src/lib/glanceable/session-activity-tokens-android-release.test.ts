import { beforeEach, describe, expect, it, vi } from 'vitest';

import { WIDGET_STORE_CLASS_MARKER } from '@/lib/auth/secure-store-gated';

import {
  _resetAndroidSessionTokensForTests,
  _setDevicePushTokenReaderForTests,
  registerAndroidSessionToken,
  releaseAndroidSessionToken,
  setAndroidSessionScope,
} from './session-activity-tokens-android';
import {
  _resetSessionTokenIdentityForTests,
  _setSessionTokenIdentityStoreForTests,
} from './session-token-identity';
import { resetTokenMutationQueue } from './token-mutation-queue';
import { SESSION_TOKEN_IDENTITY_KEY } from './widget-store';

/**
 * An unfollow's delete, when the process that wrote the row is gone and Expo
 * rotated the device token since. The row's identity on the server is the
 * account, the token and the session, so a delete naming the token read now
 * removes nothing and still reports success.
 */

const mocks = vi.hoisted(() => ({
  register: vi.fn<(input: Record<string, unknown>) => Promise<void>>(),
  unregister: vi.fn<(input: Record<string, unknown>) => Promise<void>>(),
  deviceToken: 'ExponentPushToken[device]' as string | null,
}));

vi.mock('@/lib/trpc', () => ({
  trpcClient: {
    user: {
      registerActivityToken: { mutate: mocks.register },
      unregisterActivityToken: { mutate: mocks.unregister },
    },
  },
}));

vi.mock('@/lib/auth/logout-reconciliation', () => ({
  attemptLogoutReconciliation: () => Promise.resolve(),
  awaitLogoutReconciliationSettled: () => Promise.resolve(),
  hasPendingActivityUnregister: () => Promise.resolve(false),
}));

vi.mock('@/lib/auth/token-owner', () => ({
  getAuthTokenForRequest: () => Promise.resolve('auth-token'),
}));

const CTX = { userId: 'user-1', organizationId: null };
const FOLLOW = { sessionId: 'session-1', ...CTX };

// The widget store as the keychain would hold it: the identity record, and the
// class marker that makes an absent record read as absent instead of unreadable.
const stored = new Map<string, string>();
const identityStore = {
  getItemAsync: (key: string) => Promise.resolve(stored.get(key) ?? null),
  setItemAsync: (key: string, value: string) => {
    stored.set(key, value);
    return Promise.resolve();
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.deviceToken = 'ExponentPushToken[device]';
  mocks.register.mockResolvedValue(undefined);
  mocks.unregister.mockResolvedValue(undefined);
  stored.clear();
  stored.set(WIDGET_STORE_CLASS_MARKER.key, WIDGET_STORE_CLASS_MARKER.value);
  _resetAndroidSessionTokensForTests();
  _resetSessionTokenIdentityForTests();
  _setSessionTokenIdentityStoreForTests(identityStore);
  resetTokenMutationQueue();
  setAndroidSessionScope(CTX);
  _setDevicePushTokenReaderForTests(() => Promise.resolve(mocks.deviceToken));
});

describe('releasing a row written by an earlier process', () => {
  it('deletes the row the previous process wrote after Expo rotated the token', async () => {
    await registerAndroidSessionToken(FOLLOW);
    // The token the upsert was sent with, kept on disk for the next process.
    await vi.waitFor(() => {
      expect(stored.get(SESSION_TOKEN_IDENTITY_KEY)).toContain('ExponentPushToken[device]');
    });

    // That process is gone, in memory and in the token maps; the store is not.
    _resetAndroidSessionTokensForTests();
    _resetSessionTokenIdentityForTests();
    _setSessionTokenIdentityStoreForTests(identityStore);
    setAndroidSessionScope(CTX);
    mocks.deviceToken = 'ExponentPushToken[rotated]';

    await releaseAndroidSessionToken('session-1');

    expect(mocks.unregister).toHaveBeenCalledExactlyOnceWith({
      token: 'ExponentPushToken[device]',
      sessionId: 'session-1',
    });
  });

  it('deletes both tokens when a restart re-registers after a rotation', async () => {
    await registerAndroidSessionToken(FOLLOW);
    await vi.waitFor(() => {
      expect(stored.get(SESSION_TOKEN_IDENTITY_KEY)).toContain('ExponentPushToken[device]');
    });

    /* The restore re-registers the followed session through a fresh process, so
       the record now holds both tokens; the unfollow must delete both. */
    _resetAndroidSessionTokensForTests();
    _resetSessionTokenIdentityForTests();
    _setSessionTokenIdentityStoreForTests(identityStore);
    setAndroidSessionScope(CTX);
    mocks.deviceToken = 'ExponentPushToken[rotated]';
    await registerAndroidSessionToken(FOLLOW);

    await releaseAndroidSessionToken('session-1');

    const deleted = mocks.unregister.mock.calls.map(call => call[0].token);
    expect(deleted).toHaveLength(2);
    expect(deleted).toEqual(
      expect.arrayContaining(['ExponentPushToken[device]', 'ExponentPushToken[rotated]'])
    );
  });

  it('keeps the identity a re-follow recorded while the delete was in flight', async () => {
    await registerAndroidSessionToken(FOLLOW);
    await vi.waitFor(() => {
      expect(stored.get(SESSION_TOKEN_IDENTITY_KEY)).toContain('ExponentPushToken[device]');
    });

    const gate = Promise.withResolvers<undefined>();
    mocks.unregister.mockReturnValueOnce(gate.promise);
    const release = releaseAndroidSessionToken('session-1');
    await vi.waitFor(() => {
      expect(mocks.unregister).toHaveBeenCalledTimes(1);
    });
    /* The person follows the session again while the delete is still on the
       wire: the queued upsert records the token the new row is written with,
       and the release that follows may not retire it. */
    mocks.deviceToken = 'ExponentPushToken[second]';
    const refollow = registerAndroidSessionToken(FOLLOW);
    gate.resolve(undefined);
    await Promise.all([release, refollow]);

    // A restart, then another unfollow: the re-follow's identity still names its row.
    _resetAndroidSessionTokensForTests();
    _resetSessionTokenIdentityForTests();
    _setSessionTokenIdentityStoreForTests(identityStore);
    setAndroidSessionScope(CTX);
    mocks.deviceToken = 'ExponentPushToken[third]';
    mocks.unregister.mockClear();

    await releaseAndroidSessionToken('session-1');

    expect(mocks.unregister.mock.calls.map(call => call[0].token)).toContain(
      'ExponentPushToken[second]'
    );
  });
});
