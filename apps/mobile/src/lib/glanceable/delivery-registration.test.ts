/* eslint-disable max-lines -- one stateful delivery suite shares native mocks and remote-token state across ordering regressions */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildGlanceableSnapshot } from '@kilocode/app-shared/glanceable-agents-snapshot';

const logoutMock = vi.hoisted(() => ({
  attemptLogoutReconciliation: vi.fn(),
  awaitLogoutReconciliationSettled: vi.fn(),
  hasPendingActivityUnregister: vi.fn(),
}));

const expoWidgetsMock = vi.hoisted(() => ({
  pushToStartListener: null as ((event: { activityPushToStartToken: string }) => void) | null,
  listeners: new Set<(event: { activityPushToStartToken: string }) => void>(),
}));

const trpcMock = vi.hoisted(() => ({
  registerActivityToken: { mutate: vi.fn() },
  unregisterActivityToken: { mutate: vi.fn() },
}));

const activityMock = vi.hoisted(() => ({
  getPushToken: vi.fn(),
  addPushTokenListener: vi.fn(),
  listeners: new Set<(event: { activityId: string; pushToken: string }) => void>(),
}));

const platformMock = vi.hoisted(() => ({ OS: 'ios' as string }));

/* eslint-disable import/first */
vi.mock('@/lib/auth/logout-reconciliation', () => logoutMock);
vi.mock('@/lib/auth/logout-cleanup', () => ({
  unregisterActivityTokensAndTombstone: async (lifetime: 'scope' | 'activity') => {
    await getGlanceableDelivery().unregisterTokens(lifetime);
  },
}));
vi.mock('@/lib/trpc', () => ({
  trpcClient: {
    user: {
      registerActivityToken: trpcMock.registerActivityToken,
      unregisterActivityToken: trpcMock.unregisterActivityToken,
    },
  },
}));
vi.mock('expo-widgets', () => ({
  addPushToStartTokenListener: (
    listener: (event: { activityPushToStartToken: string }) => void
  ) => {
    expoWidgetsMock.pushToStartListener = listener;
    expoWidgetsMock.listeners.add(listener);
    return { remove: () => expoWidgetsMock.listeners.delete(listener) };
  },
}));
vi.mock('@/glanceable-ios/active-agents-live-activity', () => ({
  ActiveAgentsLiveActivity: {
    getInstances: () => [activityMock],
  },
}));
vi.mock('react-native', () => ({
  Platform: platformMock,
}));

import { bumpAuthEpoch } from '@/lib/auth/auth-epoch';

import {
  getTerminalBlankEpoch,
  writePrivacySnapshotAndEnd,
  writeSignedOutSnapshotAndEnd,
} from './cleanup';
import {
  _resetLiveActivitySwitchForTests,
  setLiveActivityEnabledValue,
} from './live-activity-switch';
import { GlanceablePublisher } from './publisher';
import { getGlanceableDelivery } from './sink-registry';
// Import side effect: registers the real delivery under the mocks above.
import {
  _resetDeliveryRegistrationForTests,
  _setGetDevicePushTokenForTests,
} from './delivery-registration';
/* eslint-enable import/first */

const NOW = 1_750_000_000_000;

function trackRemoteTokens(): Map<string, string | null> {
  const rows = new Map<string, string | null>();
  trpcMock.registerActivityToken.mutate.mockImplementation(
    async (input: { token: string; organizationId: string | null }) => {
      await Promise.resolve(undefined);
      rows.set(input.token, input.organizationId);
      return { success: true };
    }
  );
  trpcMock.unregisterActivityToken.mutate.mockImplementation(async (input: { token: string }) => {
    await Promise.resolve(undefined);
    rows.delete(input.token);
    return { success: true };
  });
  return rows;
}

async function flushRegistration(): Promise<void> {
  await new Promise<void>(resolve => {
    setTimeout(resolve, 0);
  });
}

function snapshot() {
  return buildGlanceableSnapshot({
    sessions: [{ status: 'busy' }],
    userId: 'u1',
    organizationId: null,
    now: NOW,
    previousRevision: 0,
  });
}

function emitActivityToken(pushToken: string): void {
  activityMock.getPushToken.mockResolvedValue(pushToken);
  for (const listener of activityMock.listeners) {
    listener({ activityId: 'activity-1', pushToken });
  }
}

describe('delivery registerTokens', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    platformMock.OS = 'ios';
    _setGetDevicePushTokenForTests(null);
    _resetDeliveryRegistrationForTests();
    activityMock.getPushToken.mockResolvedValue('token-1');
    activityMock.listeners.clear();
    activityMock.addPushTokenListener.mockImplementation(
      (listener: (event: { activityId: string; pushToken: string }) => void) => {
        activityMock.listeners.add(listener);
        return { remove: () => activityMock.listeners.delete(listener) };
      }
    );
    trpcMock.registerActivityToken.mutate.mockResolvedValue({ success: true });
    trpcMock.unregisterActivityToken.mutate.mockResolvedValue({ success: true });
    logoutMock.attemptLogoutReconciliation.mockResolvedValue({ kind: 'no-tombstone' });
    logoutMock.awaitLogoutReconciliationSettled.mockResolvedValue(undefined);
    logoutMock.hasPendingActivityUnregister.mockResolvedValue(false);
    _resetLiveActivitySwitchForTests();
  });

  afterEach(() => {
    _resetLiveActivitySwitchForTests();
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

  it('does not register iOS tokens while a pending activity unregister is still recorded', async () => {
    logoutMock.hasPendingActivityUnregister.mockResolvedValue(true);

    getGlanceableDelivery().registerTokens(snapshot(), null, 'u1');

    await new Promise<void>(resolve => {
      setTimeout(resolve, 0);
    });

    expect(logoutMock.attemptLogoutReconciliation).toHaveBeenCalledWith('u1');
    expect(trpcMock.registerActivityToken.mutate).not.toHaveBeenCalled();
  });

  it('does not register the Android token while a pending activity unregister is still recorded', async () => {
    platformMock.OS = 'android';
    // eslint-disable-next-line promise-function-async, prefer-await-to-then -- tension between lint rules
    _setGetDevicePushTokenForTests(() => Promise.resolve('android-token-1'));
    logoutMock.hasPendingActivityUnregister.mockResolvedValue(true);

    getGlanceableDelivery().registerTokens(snapshot(), null, 'u1');
    await new Promise<void>(resolve => {
      setTimeout(resolve, 0);
    });

    expect(trpcMock.registerActivityToken.mutate).not.toHaveBeenCalled();
  });

  it('keeps both stable iOS tokens in the new org after the old deletes settle', async () => {
    const rows = trackRemoteTokens();
    expoWidgetsMock.pushToStartListener?.({ activityPushToStartToken: 'stable-start' });
    activityMock.getPushToken.mockResolvedValue('stable-activity');
    getGlanceableDelivery().registerTokens(snapshot(), 'old-org', 'u1');
    await vi.waitFor(() => {
      expect(rows).toEqual(
        new Map([
          ['stable-start', 'old-org'],
          ['stable-activity', 'old-org'],
        ])
      );
    });

    const deleteGate = Promise.withResolvers<undefined>();
    trpcMock.unregisterActivityToken.mutate.mockImplementation(async (input: { token: string }) => {
      await deleteGate.promise;
      rows.delete(input.token);
      return { success: true };
    });
    const cleanup = getGlanceableDelivery().unregisterTokens();
    getGlanceableDelivery().registerTokens(snapshot(), 'new-org', 'u1');
    await flushRegistration();
    const rowsBeforeDelete = new Map(rows);

    deleteGate.resolve(undefined);
    await cleanup;
    await flushRegistration();

    expect(rowsBeforeDelete).toEqual(
      new Map([
        ['stable-start', 'old-org'],
        ['stable-activity', 'old-org'],
      ])
    );
    expect(rows).toEqual(
      new Map([
        ['stable-start', 'new-org'],
        ['stable-activity', 'new-org'],
      ])
    );
  });

  it.each(['ios', 'android'])(
    'cancels a queued %s registration when a later end supersedes it',
    async platform => {
      platformMock.OS = platform;
      const rows = trackRemoteTokens();
      expoWidgetsMock.pushToStartListener?.({ activityPushToStartToken: 'stable-token' });
      activityMock.getPushToken.mockResolvedValue(null);
      _setGetDevicePushTokenForTests(async () => {
        await Promise.resolve(undefined);
        return 'stable-token';
      });
      getGlanceableDelivery().registerTokens(snapshot(), 'old-org', 'u1');
      await vi.waitFor(() => {
        expect(rows.get('stable-token')).toBe('old-org');
      });

      const firstDelete = Promise.withResolvers<undefined>();
      const lastDelete = Promise.withResolvers<undefined>();
      trpcMock.unregisterActivityToken.mutate
        .mockImplementationOnce(async () => {
          await firstDelete.promise;
          rows.delete('stable-token');
          return { success: true };
        })
        .mockImplementationOnce(async () => {
          await lastDelete.promise;
          rows.delete('stable-token');
          return { success: true };
        });

      const firstEnd = getGlanceableDelivery().unregisterTokens();
      getGlanceableDelivery().registerTokens(snapshot(), 'stale-org', 'u1');
      await flushRegistration();
      const lastEnd = getGlanceableDelivery().unregisterTokens();
      firstDelete.resolve(undefined);
      await firstEnd;
      await flushRegistration();
      const rowsBeforeLastDelete = new Map(rows);
      lastDelete.resolve(undefined);
      await lastEnd;

      expect(rowsBeforeLastDelete.size).toBe(0);
      expect(rows.size).toBe(0);
    }
  );

  it.each(['reconciliation', 'token lookup'])(
    'cancels iOS registration paused at %s after a later end',
    async phase => {
      const rows = trackRemoteTokens();
      const gate = Promise.withResolvers<undefined>();
      let paused = false;
      if (phase === 'reconciliation') {
        logoutMock.awaitLogoutReconciliationSettled.mockImplementationOnce(async () => {
          paused = true;
          await gate.promise;
        });
      } else {
        activityMock.getPushToken.mockImplementationOnce(async () => {
          paused = true;
          await gate.promise;
          return 'late-token';
        });
      }
      getGlanceableDelivery().registerTokens(snapshot(), 'old-org', 'u1');
      await vi.waitFor(() => {
        expect(paused).toBe(true);
      });

      await getGlanceableDelivery().unregisterTokens();
      gate.resolve(undefined);
      await flushRegistration();

      expect(rows.size).toBe(0);
    }
  );

  it.each(['ios', 'android'])(
    'allows %s registration for a new known account despite an old account cleanup',
    async platform => {
      platformMock.OS = platform;
      const rows = trackRemoteTokens();
      expoWidgetsMock.pushToStartListener?.({ activityPushToStartToken: 'stable-token' });
      activityMock.getPushToken.mockResolvedValue(null);
      _setGetDevicePushTokenForTests(async () => {
        await Promise.resolve(undefined);
        return 'stable-token';
      });
      logoutMock.attemptLogoutReconciliation.mockResolvedValue({ kind: 'spacing-skipped' });
      logoutMock.hasPendingActivityUnregister.mockImplementation(
        async (currentUser: string | null) => {
          await Promise.resolve(undefined);
          return currentUser !== 'u2';
        }
      );

      getGlanceableDelivery().registerTokens(snapshot(), 'old-org', 'u1');
      await flushRegistration();
      expect(rows.size).toBe(0);

      getGlanceableDelivery().registerTokens(snapshot(), 'new-org', 'u2');
      await flushRegistration();

      expect(rows).toEqual(new Map([['stable-token', 'new-org']]));
    }
  );

  it.each(['ios', 'android'])(
    'registers an initially idle %s scope without observing an activity',
    async platform => {
      platformMock.OS = platform;
      const rows = trackRemoteTokens();
      expoWidgetsMock.pushToStartListener?.({ activityPushToStartToken: 'scope-token' });
      _setGetDevicePushTokenForTests(async () => {
        await Promise.resolve();
        return 'scope-token';
      });
      const publisher = new GlanceablePublisher({ sinks: [], now: () => NOW });

      publisher.handleSessions([{ status: 'idle' }], { organizationId: 'org-1', userId: 'u1' });
      await flushRegistration();
      publisher.dispose();

      expect(rows).toEqual(new Map([['scope-token', 'org-1']]));
      expect(activityMock.listeners.size).toBe(0);
    }
  );

  it.each(['ios', 'android'])(
    'keeps %s scope delivery after an ordinary activity end',
    async platform => {
      platformMock.OS = platform;
      const rows = trackRemoteTokens();
      expoWidgetsMock.pushToStartListener?.({ activityPushToStartToken: 'scope-token' });
      _setGetDevicePushTokenForTests(async () => {
        await Promise.resolve();
        return 'scope-token';
      });
      getGlanceableDelivery().registerTokens(snapshot(), 'org-1', 'u1');
      await flushRegistration();

      await getGlanceableDelivery().unregisterTokens('activity');
      expect(rows).toEqual(new Map([['scope-token', 'org-1']]));

      // Background delivery can still find the scope after the visible surface ends.
      expoWidgetsMock.pushToStartListener?.({ activityPushToStartToken: 'late-scope-token' });
      await flushRegistration();
      expect(rows.get(platform === 'ios' ? 'late-scope-token' : 'scope-token')).toBe('org-1');
      await getGlanceableDelivery().unregisterTokens();
      expect(rows.size).toBe(0);
    }
  );

  it('registers late and rotated iOS tokens and removes every recorded version on scope cleanup', async () => {
    const rows = trackRemoteTokens();
    activityMock.getPushToken.mockResolvedValue(null);
    getGlanceableDelivery().registerTokens(snapshot(), 'org-1', 'u1');
    await flushRegistration();
    expect(rows.size).toBe(0);

    for (const suffix of ['first', 'rotated']) {
      expoWidgetsMock.pushToStartListener?.({ activityPushToStartToken: `start-${suffix}` });
      emitActivityToken(`activity-${suffix}`);
      // eslint-disable-next-line no-await-in-loop -- each rotation must settle before the next native event
      await flushRegistration();
      expect(rows.get(`start-${suffix}`)).toBe('org-1');
      expect(rows.get(`activity-${suffix}`)).toBe('org-1');
    }

    await getGlanceableDelivery().unregisterTokens();
    expect(rows.size).toBe(0);
    expect(activityMock.listeners.size).toBe(0);
  });

  it('holds late token events behind pending cleanup and registers them after it clears', async () => {
    const rows = trackRemoteTokens();
    logoutMock.hasPendingActivityUnregister.mockResolvedValue(true);
    getGlanceableDelivery().registerTokens(snapshot(), 'org-1', 'u1');
    expoWidgetsMock.pushToStartListener?.({ activityPushToStartToken: 'scope-token' });
    emitActivityToken('activity-token');
    await flushRegistration();
    expect(rows.size).toBe(0);

    logoutMock.hasPendingActivityUnregister.mockResolvedValue(false);
    expoWidgetsMock.pushToStartListener?.({ activityPushToStartToken: 'scope-token' });
    emitActivityToken('activity-token');
    await flushRegistration();
    expect(rows).toEqual(
      new Map([
        ['scope-token', 'org-1'],
        ['activity-token', 'org-1'],
      ])
    );
  });

  it('cleans up an uncertain upsert even after its token rotates', async () => {
    const rows = trackRemoteTokens();
    trpcMock.registerActivityToken.mutate.mockImplementationOnce(
      async (input: { token: string; organizationId: string | null }) => {
        await Promise.resolve();
        rows.set(input.token, input.organizationId);
        throw new Error('registration response lost');
      }
    );
    getGlanceableDelivery().registerTokens(snapshot(), 'org-1', 'u1');
    await flushRegistration();
    emitActivityToken('rotated-token');
    await flushRegistration();
    expect(rows.get('rotated-token')).toBe('org-1');

    await getGlanceableDelivery().unregisterTokens();
    expect(rows.size).toBe(0);
  });

  it('does not overwrite a token event with an older initial token read', async () => {
    const rows = trackRemoteTokens();
    const initialToken = Promise.withResolvers<string | null>();
    activityMock.getPushToken.mockReturnValueOnce(initialToken.promise);
    getGlanceableDelivery().registerTokens(snapshot(), 'org-1', 'u1');

    emitActivityToken('current-token');
    await flushRegistration();
    initialToken.resolve('outdated-token');
    await flushRegistration();

    expect(rows).toEqual(new Map([['current-token', 'org-1']]));
  });

  it('replaces the activity listener and rejects delayed events from the ended activity', async () => {
    const rows = trackRemoteTokens();
    expoWidgetsMock.pushToStartListener?.({ activityPushToStartToken: 'scope-token' });
    getGlanceableDelivery().registerTokens(snapshot(), 'org-1', 'u1');
    await flushRegistration();
    const oldListener = [...activityMock.listeners][0];
    const replacement = {
      getPushToken: async () => {
        await Promise.resolve();
        return 'replacement-token';
      },
      addPushTokenListener: () => ({ remove: () => undefined }),
    };

    getGlanceableDelivery().registerTokens(snapshot(), 'org-1', 'u1', replacement);
    oldListener?.({ activityId: 'old-activity', pushToken: 'stale-event-token' });
    await flushRegistration();

    expect(rows).toEqual(
      new Map([
        ['scope-token', 'org-1'],
        ['replacement-token', 'org-1'],
      ])
    );
    expect(activityMock.listeners.size).toBe(0);
  });

  it('fences old scope listeners while cleanup waits and after a replacement scope registers', async () => {
    const rows = trackRemoteTokens();
    expoWidgetsMock.pushToStartListener?.({ activityPushToStartToken: 'scope-token' });
    getGlanceableDelivery().registerTokens(snapshot(), 'old-org', 'u1');
    await flushRegistration();
    const oldStartListener = expoWidgetsMock.pushToStartListener;
    const oldActivityListener = [...activityMock.listeners][0];
    const deleting = Promise.withResolvers<undefined>();
    const deleteGate = Promise.withResolvers<undefined>();
    trpcMock.unregisterActivityToken.mutate.mockImplementationOnce(
      async (input: { token: string }) => {
        deleting.resolve(undefined);
        await deleteGate.promise;
        rows.delete(input.token);
        return { success: true };
      }
    );

    const cleanup = getGlanceableDelivery().unregisterTokens();
    await deleting.promise;
    oldStartListener?.({ activityPushToStartToken: 'stale-start-during-cleanup' });
    oldActivityListener?.({
      activityId: 'old-activity',
      pushToken: 'stale-activity-during-cleanup',
    });
    getGlanceableDelivery().registerTokens(snapshot(), 'new-org', 'u1');
    deleteGate.resolve(undefined);
    await cleanup;
    await flushRegistration();
    oldStartListener?.({ activityPushToStartToken: 'stale-start-after-cleanup' });
    oldActivityListener?.({
      activityId: 'old-activity',
      pushToken: 'stale-activity-after-cleanup',
    });
    await flushRegistration();

    expect(rows).toEqual(
      new Map([
        ['scope-token', 'new-org'],
        ['token-1', 'new-org'],
      ])
    );
    expect(expoWidgetsMock.listeners.size).toBe(1);
    expect(activityMock.listeners.size).toBe(1);
  });

  it.each(['signed_out', 'privacy'] as const)(
    'invalidates listeners and the publisher on %s without losing cleanup',
    async status => {
      const rows = trackRemoteTokens();
      expoWidgetsMock.pushToStartListener?.({ activityPushToStartToken: 'scope-token' });
      getGlanceableDelivery().registerTokens(snapshot(), 'org-1', 'u1');
      await flushRegistration();
      const oldStartListener = expoWidgetsMock.pushToStartListener;
      const oldActivityListener = [...activityMock.listeners][0];
      const publisher = new GlanceablePublisher({
        sinks: [],
        terminalBlankEpoch: getTerminalBlankEpoch,
      });

      if (status === 'signed_out') {
        writeSignedOutSnapshotAndEnd();
      } else {
        writePrivacySnapshotAndEnd();
      }
      oldStartListener?.({ activityPushToStartToken: 'late-start' });
      oldActivityListener?.({ activityId: 'old-activity', pushToken: 'late-activity' });
      publisher.handleSessions([{ status: 'busy' }], { organizationId: 'org-1', userId: 'u1' });
      await flushRegistration();
      publisher.dispose();

      expect(rows.size).toBe(0);
      expect(activityMock.listeners.size).toBe(0);
    }
  );

  it('rejects token events when the authentication epoch changes', async () => {
    const rows = trackRemoteTokens();
    getGlanceableDelivery().registerTokens(snapshot(), 'org-1', 'u1');
    await flushRegistration();

    bumpAuthEpoch();
    expoWidgetsMock.pushToStartListener?.({ activityPushToStartToken: 'wrong-auth-start' });
    emitActivityToken('wrong-auth-activity');
    await flushRegistration();

    expect(rows).toEqual(new Map([['token-1', 'org-1']]));
  });

  it('does not re-register the push-to-start subscription while the switch is off', async () => {
    const rows = trackRemoteTokens();
    expoWidgetsMock.pushToStartListener?.({ activityPushToStartToken: 'scope-token' });
    getGlanceableDelivery().registerScopeTokens('org-1', 'u1');
    await flushRegistration();
    expect(rows).toEqual(new Map([['scope-token', 'org-1']]));

    // The switch going off retires the subscription, exactly as the iOS
    // register does alongside `endImmediate`.
    setLiveActivityEnabledValue(false);
    await getGlanceableDelivery().unregisterTokens('scope');
    expect(rows.size).toBe(0);

    // A later cache success must not hand the server a remote start again.
    expoWidgetsMock.pushToStartListener?.({ activityPushToStartToken: 'scope-token' });
    getGlanceableDelivery().registerScopeTokens('org-1', 'u1');
    await flushRegistration();
    expect(rows.size).toBe(0);

    // Switching back on restores it on the next scope refresh.
    setLiveActivityEnabledValue(true);
    getGlanceableDelivery().registerScopeTokens('org-1', 'u1');
    await flushRegistration();
    expect(rows).toEqual(new Map([['scope-token', 'org-1']]));
  });

  it('waits for an in-flight activity upsert before removing only activity tokens', async () => {
    const rows = trackRemoteTokens();
    expoWidgetsMock.pushToStartListener?.({ activityPushToStartToken: 'scope-token' });
    getGlanceableDelivery().registerScopeTokens('org-1', 'u1');
    await flushRegistration();
    const registering = Promise.withResolvers<undefined>();
    const registerGate = Promise.withResolvers<undefined>();
    trpcMock.registerActivityToken.mutate.mockImplementationOnce(
      async (input: { token: string; organizationId: string | null }) => {
        registering.resolve(undefined);
        await registerGate.promise;
        rows.set(input.token, input.organizationId);
        return { success: true };
      }
    );
    getGlanceableDelivery().registerTokens(snapshot(), 'org-1', 'u1');
    await registering.promise;

    const ending = getGlanceableDelivery().unregisterTokens('activity');
    registerGate.resolve(undefined);
    await ending;

    expect(rows).toEqual(new Map([['scope-token', 'org-1']]));
  });

  it('retains only failed retired activity tokens for cleanup without deleting the scope', async () => {
    const rows = trackRemoteTokens();
    expoWidgetsMock.pushToStartListener?.({ activityPushToStartToken: 'scope-token' });
    getGlanceableDelivery().registerTokens(snapshot(), 'org-1', 'u1');
    await flushRegistration();
    emitActivityToken('rotated-activity');
    await flushRegistration();
    trpcMock.unregisterActivityToken.mutate.mockRejectedValueOnce(new Error('network'));

    const result = await getGlanceableDelivery().unregisterTokens('activity');

    expect(result).toEqual({ ok: false, tokens: ['token-1'] });
    expect(rows).toEqual(
      new Map([
        ['scope-token', 'org-1'],
        ['token-1', 'org-1'],
      ])
    );
    await getGlanceableDelivery().unregisterTokens();
    expect(rows.size).toBe(0);
  });

  it('discovers a cold activity without a scope registration and retains a failed token after native end', async () => {
    const rows = trackRemoteTokens();
    rows.set('scope-token', 'org-1');
    rows.set('token-1', 'org-1');
    trpcMock.unregisterActivityToken.mutate.mockRejectedValueOnce(new Error('network'));

    expect(await getGlanceableDelivery().unregisterTokens('activity')).toEqual({
      ok: false,
      tokens: ['token-1'],
    });
    expect(rows).toEqual(
      new Map([
        ['scope-token', 'org-1'],
        ['token-1', 'org-1'],
      ])
    );

    activityMock.getPushToken.mockResolvedValue(null);
    expect(await getGlanceableDelivery().unregisterTokens('activity')).toEqual({
      ok: true,
      tokens: [],
    });
    expect(rows).toEqual(new Map([['scope-token', 'org-1']]));
  });

  it('returns only the failed iOS tokens on a partial unregister failure', async () => {
    expoWidgetsMock.pushToStartListener?.({ activityPushToStartToken: 'ptt-token' });
    activityMock.getPushToken.mockResolvedValue('activity-token-1');

    // Tokens are unregistered in gather order (push-to-start first): the first
    // unregister fails while the activity unregister succeeds.
    trpcMock.unregisterActivityToken.mutate
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce({ success: true });

    const result = await getGlanceableDelivery().unregisterTokens();

    expect(result).toEqual({ ok: false, tokens: ['ptt-token'] });
    expect(trpcMock.unregisterActivityToken.mutate).toHaveBeenCalledTimes(2);
  });
});
