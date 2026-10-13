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

describe('a release while the registration is in flight', () => {
  it('does not claim the row it deleted, so a re-follow upserts it again', async () => {
    const { promise: upsert, resolve: answer } = Promise.withResolvers<undefined>();
    mocks.register.mockReturnValueOnce(upsert);

    const first = registerAndroidSessionToken(FOLLOW);
    await vi.waitFor(() => {
      expect(mocks.register).toHaveBeenCalledTimes(1);
    });
    // Unfollow while the upsert is on the wire: its delete queues behind it.
    const release = releaseAndroidSessionToken('session-1');
    // Follow again before the first upsert answers.
    const second = registerAndroidSessionToken(FOLLOW);
    answer(undefined);
    await Promise.all([first, release, second]);

    // The re-follow is the later call, so the release's delete is superseded
    // and the re-follow upserts its own row: the row exists at the end, and
    // nothing was deleted after the last upsert.
    expect(mocks.register).toHaveBeenCalledTimes(2);
    expect(mocks.unregister).not.toHaveBeenCalled();
    expect(isAndroidSessionTokenPending('session-1')).toBe(false);
  });

  it('leaves no row claimed when nothing follows the session afterwards', async () => {
    const { promise: upsert, resolve: answer } = Promise.withResolvers<undefined>();
    mocks.register.mockReturnValueOnce(upsert);
    const first = registerAndroidSessionToken(FOLLOW);
    await vi.waitFor(() => {
      expect(mocks.register).toHaveBeenCalledTimes(1);
    });
    const release = releaseAndroidSessionToken('session-1');
    answer(undefined);
    await Promise.all([first, release]);

    // A later follow must upsert: the row was deleted after the first upsert.
    await registerAndroidSessionToken(FOLLOW);
    expect(mocks.register).toHaveBeenCalledTimes(2);
  });
});

describe('a release and a re-follow commute: the later call wins', () => {
  /** A device-token reader whose first read waits for `open()`; later reads answer at once. */
  function slowFirstTokenRead(): { open: () => void } {
    const { promise, resolve } = Promise.withResolvers<undefined>();
    let first = true;
    _setDevicePushTokenReaderForTests(async () => {
      if (first) {
        first = false;
        await promise;
      }
      return mocks.deviceToken;
    });
    return {
      open: () => {
        resolve(undefined);
      },
    };
  }

  it('a re-follow whose upsert runs before the release delete keeps the row', async () => {
    // A fresh process knows no token, so the release must read the device
    // token first; the re-follow's upsert overtakes it in the FIFO.
    const read = slowFirstTokenRead();
    const release = releaseAndroidSessionToken('session-1');
    await registerAndroidSessionToken(FOLLOW);
    expect(mocks.register).toHaveBeenCalledTimes(1);

    read.open();
    await release;

    // The superseded delete must not remove the row the re-follow holds.
    expect(mocks.unregister).not.toHaveBeenCalled();
    expect(isAndroidSessionTokenPending('session-1')).toBe(false);
    // The row is still claimed: another retry sends nothing.
    await retryAndroidSessionTokens();
    expect(mocks.register).toHaveBeenCalledTimes(1);
  });

  it('a release made after the re-follow still deletes the row', async () => {
    const read = slowFirstTokenRead();
    const firstRelease = releaseAndroidSessionToken('session-1');
    await registerAndroidSessionToken(FOLLOW);
    // The user unfollows again: this release is now the latest call.
    await releaseAndroidSessionToken('session-1');
    read.open();
    await firstRelease;

    expect(mocks.register).toHaveBeenCalledTimes(1);
    // Only the latest release deletes; the superseded first one does nothing.
    expect(mocks.unregister).toHaveBeenCalledExactlyOnceWith({
      token: 'ExponentPushToken[device]',
      sessionId: 'session-1',
    });
    const upsertAt = mocks.register.mock.invocationCallOrder[0] ?? 0;
    const deleteAt = mocks.unregister.mock.invocationCallOrder[0] ?? 0;
    expect(deleteAt).toBeGreaterThan(upsertAt);

    // Nothing claims the deleted row: a later follow upserts it again.
    await registerAndroidSessionToken(FOLLOW);
    expect(mocks.register).toHaveBeenCalledTimes(2);
  });

  it('a release queued ahead of a re-follow does not delete the row the re-follow then holds', async () => {
    // The release reads its token at once (the row is claimed), so its delete
    // is queued first; the re-follow still wins because it was called later.
    await registerAndroidSessionToken(FOLLOW);
    const release = releaseAndroidSessionToken('session-1');
    const refollow = registerAndroidSessionToken(FOLLOW);
    await Promise.all([release, refollow]);

    expect(mocks.unregister).not.toHaveBeenCalled();
    expect(mocks.register).toHaveBeenCalledTimes(2);
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
