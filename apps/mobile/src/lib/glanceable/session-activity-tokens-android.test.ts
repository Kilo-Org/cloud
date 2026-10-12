import { beforeEach, describe, expect, it, vi } from 'vitest';

import { bumpAuthEpoch } from '@/lib/auth/auth-epoch';

import {
  _resetAndroidSessionTokensForTests,
  _setDevicePushTokenReaderForTests,
  androidSessionActivityTokens,
  isAndroidSessionTokenPending,
  registerAndroidSessionToken,
  releaseAndroidSessionToken,
  retryAndroidSessionTokens,
  setAndroidSessionScope,
} from './session-activity-tokens-android';
import { resetTokenMutationQueue } from './token-mutation-queue';

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
  attemptLogoutReconciliation: vi.fn(async () => {
    await Promise.resolve();
  }),
  awaitLogoutReconciliationSettled: vi.fn(async () => {
    await Promise.resolve();
  }),
  hasPendingActivityUnregister: vi.fn(async () => {
    await Promise.resolve();
    return false;
  }),
}));

vi.mock('@/lib/auth/token-owner', () => ({
  getAuthTokenForRequest: vi.fn(async () => {
    await Promise.resolve();
    return 'auth-token';
  }),
}));

const CTX = { userId: 'user-1', organizationId: null };
const FOLLOW = { sessionId: 'session-1', ...CTX };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.deviceToken = 'ExponentPushToken[device]';
  mocks.register.mockResolvedValue(undefined);
  mocks.unregister.mockResolvedValue(undefined);
  _resetAndroidSessionTokensForTests();
  resetTokenMutationQueue();
  setAndroidSessionScope(CTX);
  _setDevicePushTokenReaderForTests(async () => {
    await Promise.resolve();
    return mocks.deviceToken;
  });
});

describe('registerAndroidSessionToken', () => {
  it('registers the device token for the followed session', async () => {
    await registerAndroidSessionToken(FOLLOW);

    expect(mocks.register).toHaveBeenCalledExactlyOnceWith({
      token: 'ExponentPushToken[device]',
      kind: 'android_session_ongoing',
      platform: 'android',
      organizationId: null,
      sessionId: 'session-1',
    });
    expect(isAndroidSessionTokenPending('session-1')).toBe(false);
  });

  it('keeps a failed registration pending and lands it on the next retry', async () => {
    mocks.register.mockRejectedValueOnce(new Error('Request timed out after 15000ms'));

    await registerAndroidSessionToken(FOLLOW);
    // The upsert may have landed before the timeout: its token is recorded for cleanup.
    expect(isAndroidSessionTokenPending('session-1')).toBe(true);
    expect(androidSessionActivityTokens.has('ExponentPushToken[device]')).toBe(true);

    await retryAndroidSessionTokens();

    expect(mocks.register).toHaveBeenCalledTimes(2);
    expect(isAndroidSessionTokenPending('session-1')).toBe(false);

    // A landed registration is not sent again.
    await retryAndroidSessionTokens();
    expect(mocks.register).toHaveBeenCalledTimes(2);
  });

  it('keeps the follow pending while the device token cannot be read', async () => {
    mocks.deviceToken = null;
    await registerAndroidSessionToken(FOLLOW);
    expect(mocks.register).not.toHaveBeenCalled();
    expect(isAndroidSessionTokenPending('session-1')).toBe(true);

    mocks.deviceToken = 'ExponentPushToken[device]';
    await retryAndroidSessionTokens();
    expect(mocks.register).toHaveBeenCalledTimes(1);
  });

  it('drops a follow made before a sign-in or sign-out instead of registering it', async () => {
    mocks.register.mockRejectedValueOnce(new Error('offline'));
    await registerAndroidSessionToken(FOLLOW);
    bumpAuthEpoch();

    await retryAndroidSessionTokens();

    expect(mocks.register).toHaveBeenCalledTimes(1);
    expect(isAndroidSessionTokenPending('session-1')).toBe(false);
  });

  it('does not register a follow released while its attempt waited', async () => {
    mocks.register.mockRejectedValueOnce(new Error('offline'));
    await registerAndroidSessionToken(FOLLOW);

    await releaseAndroidSessionToken('session-1');
    await retryAndroidSessionTokens();

    expect(mocks.register).toHaveBeenCalledTimes(1);
  });
});

describe('releaseAndroidSessionToken', () => {
  it('deletes only that session row, with the token the server accepted', async () => {
    await registerAndroidSessionToken(FOLLOW);

    await releaseAndroidSessionToken('session-1');

    expect(mocks.unregister).toHaveBeenCalledExactlyOnceWith({
      token: 'ExponentPushToken[device]',
      sessionId: 'session-1',
    });
  });

  it('reads the device token when this process never registered the session', async () => {
    // A fresh headless process: a dismissal or a push for an unfollowed session.
    await releaseAndroidSessionToken('session-9');

    expect(mocks.unregister).toHaveBeenCalledExactlyOnceWith({
      token: 'ExponentPushToken[device]',
      sessionId: 'session-9',
    });
  });
});
