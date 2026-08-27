import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildGlanceableSnapshot } from '@kilocode/app-shared/glanceable-agents-snapshot';

const logoutMock = vi.hoisted(() => ({
  attemptLogoutReconciliation: vi.fn(),
  awaitLogoutReconciliationSettled: vi.fn(),
}));

const trpcMock = vi.hoisted(() => ({
  registerActivityToken: { mutate: vi.fn() },
  unregisterActivityToken: { mutate: vi.fn() },
}));

const activityMock = vi.hoisted(() => ({
  getPushToken: vi.fn(),
}));

const platformMock = vi.hoisted(() => ({ OS: 'ios' as string }));

/* eslint-disable import/first */
vi.mock('@/lib/auth/logout-reconciliation', () => logoutMock);
vi.mock('@/lib/trpc', () => ({
  trpcClient: {
    user: {
      registerActivityToken: trpcMock.registerActivityToken,
      unregisterActivityToken: trpcMock.unregisterActivityToken,
    },
  },
}));
vi.mock('expo-widgets', () => ({
  addPushToStartTokenListener: vi.fn(),
}));
vi.mock('@/glanceable-ios/active-agents-live-activity', () => ({
  ActiveAgentsLiveActivity: {
    getInstances: () => [activityMock],
  },
}));
vi.mock('react-native', () => ({
  Platform: platformMock,
}));

import { getGlanceableDelivery } from './sink-registry';
// Import side effect: registers the real delivery under the mocks above.
import {
  _resetAndroidOngoingTokenForTests,
  _setGetDevicePushTokenForTests,
} from './delivery-registration';
/* eslint-enable import/first */

const NOW = 1_750_000_000_000;

function snapshot() {
  return buildGlanceableSnapshot({
    sessions: [{ status: 'busy' }],
    userId: 'u1',
    organizationId: null,
    now: NOW,
    previousRevision: 0,
  });
}

describe('delivery registerTokens', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    platformMock.OS = 'ios';
    _setGetDevicePushTokenForTests(null);
    _resetAndroidOngoingTokenForTests();
    activityMock.getPushToken.mockResolvedValue('token-1');
    trpcMock.registerActivityToken.mutate.mockResolvedValue({ success: true });
    trpcMock.unregisterActivityToken.mutate.mockResolvedValue({ success: true });
    logoutMock.attemptLogoutReconciliation.mockResolvedValue({ kind: 'no-tombstone' });
    logoutMock.awaitLogoutReconciliationSettled.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not register the activity token while logout reconciliation for this sign-in is still running', async () => {
    const gate = { release: null as (() => void) | null };
    const settledGate = new Promise<void>(resolve => {
      gate.release = resolve;
    });
    logoutMock.attemptLogoutReconciliation.mockReturnValue({ kind: 'in-flight' });
    logoutMock.awaitLogoutReconciliationSettled.mockImplementation(async () => {
      await settledGate;
    });

    getGlanceableDelivery().registerTokens(snapshot(), null, 'u1');

    // Flush microtasks and a macrotask: logout reconciliation is still in
    // flight, so the activity token must not have registered.
    await new Promise<void>(resolve => {
      setTimeout(resolve, 0);
    });

    expect(logoutMock.attemptLogoutReconciliation).toHaveBeenCalledWith('u1');
    expect(trpcMock.registerActivityToken.mutate).not.toHaveBeenCalled();

    gate.release?.();
    await vi.waitFor(() => {
      expect(trpcMock.registerActivityToken.mutate).toHaveBeenCalledWith({
        token: 'token-1',
        kind: 'ios_activity',
        platform: 'ios',
        organizationId: null,
      });
    });
  });

  it('registers the device Expo push token as android_ongoing on a successful Android start', async () => {
    platformMock.OS = 'android';
    // eslint-disable-next-line promise-function-async, prefer-await-to-then -- tension between lint rules
    _setGetDevicePushTokenForTests(() => Promise.resolve('android-token-1'));

    getGlanceableDelivery().registerTokens(snapshot(), 'org-1', 'u1');
    await vi.waitFor(() => {
      expect(trpcMock.registerActivityToken.mutate).toHaveBeenCalledWith({
        token: 'android-token-1',
        kind: 'android_ongoing',
        platform: 'android',
        organizationId: 'org-1',
      });
    });
  });

  it('does not register on Android when the device has no push token', async () => {
    platformMock.OS = 'android';
    // eslint-disable-next-line promise-function-async, prefer-await-to-then -- tension between lint rules
    _setGetDevicePushTokenForTests(() => Promise.resolve(null));

    getGlanceableDelivery().registerTokens(snapshot(), null, 'u1');
    await new Promise<void>(resolve => {
      setTimeout(resolve, 0);
    });

    expect(trpcMock.registerActivityToken.mutate).not.toHaveBeenCalled();
  });

  it('unregisters the recorded android_ongoing token and clears it on success', async () => {
    platformMock.OS = 'android';
    // eslint-disable-next-line promise-function-async, prefer-await-to-then -- tension between lint rules
    _setGetDevicePushTokenForTests(() => Promise.resolve('android-token-1'));
    getGlanceableDelivery().registerTokens(snapshot(), null, 'u1');
    await vi.waitFor(() => {
      expect(trpcMock.registerActivityToken.mutate).toHaveBeenCalled();
    });

    const result = await getGlanceableDelivery().unregisterTokens();
    expect(result).toEqual({ ok: true, tokens: ['android-token-1'] });
    expect(trpcMock.unregisterActivityToken.mutate).toHaveBeenCalledWith({
      token: 'android-token-1',
    });

    // A second unregister has nothing recorded to attempt.
    const second = await getGlanceableDelivery().unregisterTokens();
    expect(second).toEqual({ ok: true, tokens: [] });
  });

  it('reports a failed android_ongoing unregister and keeps the token for retry', async () => {
    platformMock.OS = 'android';
    // eslint-disable-next-line promise-function-async, prefer-await-to-then -- tension between lint rules
    _setGetDevicePushTokenForTests(() => Promise.resolve('android-token-1'));
    getGlanceableDelivery().registerTokens(snapshot(), null, 'u1');
    await vi.waitFor(() => {
      expect(trpcMock.registerActivityToken.mutate).toHaveBeenCalled();
    });

    trpcMock.unregisterActivityToken.mutate.mockRejectedValueOnce(new Error('network'));
    const result = await getGlanceableDelivery().unregisterTokens();
    expect(result).toEqual({ ok: false, tokens: ['android-token-1'] });

    // The failed unregister kept the token: a following unregister still
    // targets the same token.
    const retry = await getGlanceableDelivery().unregisterTokens();
    expect(retry).toEqual({ ok: true, tokens: ['android-token-1'] });
    expect(trpcMock.unregisterActivityToken.mutate).toHaveBeenLastCalledWith({
      token: 'android-token-1',
    });
  });

  it('blocks a late register and does not unregister the token it recorded while in flight', async () => {
    platformMock.OS = 'android';
    const tokenResolver: { resolve: ((value: string | null) => void) | null } = {
      resolve: null,
    };
    let tokenLookupCalled = false;
    // eslint-disable-next-line promise-function-async, prefer-await-to-then -- tension between lint rules
    const deferredToken = (): Promise<string | null> =>
      new Promise<string | null>(resolve => {
        tokenLookupCalled = true;
        tokenResolver.resolve = resolve;
      });
    _setGetDevicePushTokenForTests(deferredToken);

    getGlanceableDelivery().registerTokens(snapshot(), 'org-1', 'u1');
    await vi.waitFor(() => {
      expect(tokenLookupCalled).toBe(true);
    });

    // Unregister while the register is still in flight at the token lookup:
    // the unregister snapshots the (empty) recorded token and does not await
    // the in-flight register.
    const result = await getGlanceableDelivery().unregisterTokens();
    tokenResolver.resolve?.('android-token-1');
    await new Promise<void>(resolve => {
      setTimeout(resolve, 0);
    });

    expect(result).toEqual({ ok: true, tokens: [] });
    expect(trpcMock.registerActivityToken.mutate).not.toHaveBeenCalled();
    expect(trpcMock.unregisterActivityToken.mutate).not.toHaveBeenCalled();
  });

  it("keeps a later start's row when a register is in flight during unregister", async () => {
    platformMock.OS = 'android';
    const firstResolver: { resolve: ((value: string | null) => void) | null } = {
      resolve: null,
    };
    let firstLookupCalled = false;
    // eslint-disable-next-line promise-function-async, prefer-await-to-then -- tension between lint rules
    const deferredFirst = (): Promise<string | null> =>
      new Promise<string | null>(resolve => {
        firstLookupCalled = true;
        firstResolver.resolve = resolve;
      });
    _setGetDevicePushTokenForTests(deferredFirst);

    getGlanceableDelivery().registerTokens(snapshot(), 'org-1', 'u1');
    await vi.waitFor(() => {
      expect(firstLookupCalled).toBe(true);
    });

    // End while the first register is still in flight at the token lookup.
    const unregisterPromise = getGlanceableDelivery().unregisterTokens();

    // Immediate restart: a second register records and registers its token
    // while the unregister is still settling.
    // eslint-disable-next-line promise-function-async, prefer-await-to-then -- tension between lint rules
    _setGetDevicePushTokenForTests(() => Promise.resolve('android-token-2'));
    getGlanceableDelivery().registerTokens(snapshot(), 'org-1', 'u1');
    await vi.waitFor(() => {
      expect(trpcMock.registerActivityToken.mutate).toHaveBeenCalledWith({
        token: 'android-token-2',
        kind: 'android_ongoing',
        platform: 'android',
        organizationId: 'org-1',
      });
    });

    // Let the first register's stalled lookup finish; it must abort and must
    // not delete the second register's row.
    firstResolver.resolve?.('android-token-1');
    const unregisterResult = await unregisterPromise;

    expect(trpcMock.registerActivityToken.mutate).toHaveBeenCalledTimes(1);
    expect(trpcMock.unregisterActivityToken.mutate).not.toHaveBeenCalled();
    expect(unregisterResult).toEqual({ ok: true, tokens: [] });
  });

  it("keeps a later start's row for the same device token (end-then-restart)", async () => {
    platformMock.OS = 'android';
    // eslint-disable-next-line promise-function-async, prefer-await-to-then -- tension between lint rules
    _setGetDevicePushTokenForTests(() => Promise.resolve('android-token-1'));

    // First start registers the device token.
    getGlanceableDelivery().registerTokens(snapshot(), 'org-1', 'u1');
    await vi.waitFor(() => {
      expect(trpcMock.registerActivityToken.mutate).toHaveBeenCalledTimes(1);
    });

    // End: hold the server delete in flight.
    const deleteGateState = { release: undefined as ((value: unknown) => void) | undefined };
    const deleteGate = new Promise(resolve => {
      deleteGateState.release = resolve;
    });
    // eslint-disable-next-line promise-function-async -- controllable promise for the race test
    trpcMock.unregisterActivityToken.mutate.mockImplementationOnce(() => deleteGate);
    const unregisterPromise = getGlanceableDelivery().unregisterTokens();

    // Immediate restart with the same device token while the delete is in flight.
    getGlanceableDelivery().registerTokens(snapshot(), 'org-1', 'u1');
    // The re-register is serialized behind the in-flight delete, so it has not
    // run yet.
    await new Promise<void>(resolve => {
      setTimeout(resolve, 0);
    });
    expect(trpcMock.registerActivityToken.mutate).toHaveBeenCalledTimes(1);

    // Release the delete; the serialized re-register then runs and wins.
    deleteGateState.release?.({ success: true });
    await vi.waitFor(() => {
      expect(trpcMock.registerActivityToken.mutate).toHaveBeenCalledTimes(2);
    });

    const result = await unregisterPromise;
    expect(result).toEqual({ ok: true, tokens: ['android-token-1'] });
    expect(trpcMock.unregisterActivityToken.mutate).toHaveBeenCalledTimes(1);

    // The final state is re-registered: a later unregister targets the token.
    const final = await getGlanceableDelivery().unregisterTokens();
    expect(final).toEqual({ ok: true, tokens: ['android-token-1'] });
  });
});
