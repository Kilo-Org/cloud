import { beforeEach, describe, expect, it, vi } from 'vitest';

const logoutMock = vi.hoisted(() => ({
  attemptLogoutReconciliation: vi.fn(),
  awaitLogoutReconciliationSettled: vi.fn(),
}));

const notificationsMock = vi.hoisted(() => ({
  getDevicePushTokenOutcome: vi.fn(),
  getPlatform: vi.fn(),
}));

const trpcMock = vi.hoisted(() => ({
  getMyPushTokens: { query: vi.fn() },
  registerPushToken: { mutate: vi.fn() },
  unregisterPushToken: { mutate: vi.fn() },
}));

const queryClientMock = vi.hoisted(() => ({
  invalidateQueries: vi.fn(),
}));

const expoNotificationsMock = vi.hoisted(() => {
  let listener: ((token: unknown) => void) | null = null;
  let remove: (() => void) | null = null;
  return {
    addPushTokenListener: vi.fn((l: (token: unknown) => void) => {
      listener = l;
      remove = vi.fn<() => void>();
      return { remove };
    }),
    lastListener: () => listener,
    lastRemove: () => remove,
  };
});

/* eslint-disable import/first */
vi.mock('@/lib/auth/logout-reconciliation', () => logoutMock);
vi.mock('@/lib/notifications', () => notificationsMock);
vi.mock('@/lib/trpc', () => ({
  trpcClient: { user: trpcMock },
}));
vi.mock('@/lib/query-client', () => ({
  queryClient: queryClientMock,
}));
vi.mock('expo-notifications', () => ({
  addPushTokenListener: expoNotificationsMock.addPushTokenListener,
}));

import { bumpAuthEpoch } from '@/lib/auth/auth-epoch';
import {
  attemptPushRegistrationReconciliation,
  resetPushRegistrationReconciliationForTests,
  subscribeToPushTokenRotation,
} from '@/lib/auth/push-registration-reconciliation';
/* eslint-enable import/first */

describe('attemptPushRegistrationReconciliation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetPushRegistrationReconciliationForTests();
    logoutMock.attemptLogoutReconciliation.mockResolvedValue({ kind: 'no-tombstone' });
    logoutMock.awaitLogoutReconciliationSettled.mockResolvedValue(undefined);
    notificationsMock.getPlatform.mockReturnValue('ios');
    queryClientMock.invalidateQueries.mockResolvedValue(undefined);
  });

  it('returns no-permission and makes no network call when the device holds no token', async () => {
    notificationsMock.getDevicePushTokenOutcome.mockResolvedValue({ kind: 'none' });

    const outcome = await attemptPushRegistrationReconciliation('u1');

    expect(outcome).toEqual({ kind: 'no-permission' });
    expect(trpcMock.getMyPushTokens.query).not.toHaveBeenCalled();
    expect(trpcMock.registerPushToken.mutate).not.toHaveBeenCalled();
  });

  it('returns lookup-failed when the device token lookup fails', async () => {
    notificationsMock.getDevicePushTokenOutcome.mockResolvedValue({ kind: 'lookup-failed' });

    const outcome = await attemptPushRegistrationReconciliation('u1');

    expect(outcome).toEqual({ kind: 'lookup-failed' });
    expect(trpcMock.getMyPushTokens.query).not.toHaveBeenCalled();
    expect(trpcMock.registerPushToken.mutate).not.toHaveBeenCalled();
  });

  it('returns already-registered and performs no write when the token is present', async () => {
    notificationsMock.getDevicePushTokenOutcome.mockResolvedValue({
      kind: 'token',
      token: 'push-1',
    });
    trpcMock.getMyPushTokens.query.mockResolvedValue([{ token: 'push-1', platform: 'ios' }]);

    const outcome = await attemptPushRegistrationReconciliation('u1');

    expect(outcome).toEqual({ kind: 'already-registered' });
    expect(trpcMock.registerPushToken.mutate).not.toHaveBeenCalled();
    expect(queryClientMock.invalidateQueries).not.toHaveBeenCalled();
  });

  it('registers the Expo token on a fresh sign-in and invalidates the query', async () => {
    notificationsMock.getDevicePushTokenOutcome.mockResolvedValue({
      kind: 'token',
      token: 'push-1',
    });
    trpcMock.getMyPushTokens.query.mockResolvedValue([]);
    trpcMock.registerPushToken.mutate.mockResolvedValue({ success: true });

    const outcome = await attemptPushRegistrationReconciliation('u1');

    expect(outcome).toEqual({ kind: 'registered' });
    expect(trpcMock.registerPushToken.mutate).toHaveBeenCalledWith({
      token: 'push-1',
      platform: 'ios',
    });
    expect(queryClientMock.invalidateQueries).toHaveBeenCalledTimes(1);
  });

  it('returns register-failed when the token lookup query rejects', async () => {
    notificationsMock.getDevicePushTokenOutcome.mockResolvedValue({
      kind: 'token',
      token: 'push-1',
    });
    trpcMock.getMyPushTokens.query.mockRejectedValue(new Error('server 500'));

    const outcome = await attemptPushRegistrationReconciliation('u1');

    expect(outcome).toEqual({ kind: 'register-failed' });
    expect(trpcMock.registerPushToken.mutate).not.toHaveBeenCalled();
    expect(queryClientMock.invalidateQueries).not.toHaveBeenCalled();
  });

  it('returns register-failed when the register mutate rejects', async () => {
    notificationsMock.getDevicePushTokenOutcome.mockResolvedValue({
      kind: 'token',
      token: 'push-1',
    });
    trpcMock.getMyPushTokens.query.mockResolvedValue([]);
    trpcMock.registerPushToken.mutate.mockRejectedValue(new Error('server 500'));

    const outcome = await attemptPushRegistrationReconciliation('u1');

    expect(outcome).toEqual({ kind: 'register-failed' });
    expect(queryClientMock.invalidateQueries).not.toHaveBeenCalled();
  });

  it('skips a second attempt within the 60 s spacing window', async () => {
    notificationsMock.getDevicePushTokenOutcome.mockResolvedValue({
      kind: 'token',
      token: 'push-1',
    });
    trpcMock.getMyPushTokens.query.mockResolvedValue([]);
    trpcMock.registerPushToken.mutate.mockResolvedValue({ success: true });

    const first = await attemptPushRegistrationReconciliation('u1');
    const second = await attemptPushRegistrationReconciliation('u1');

    expect(first.kind).toBe('registered');
    expect(second).toEqual({ kind: 'spacing-skipped' });
  });

  it('single-flights concurrent attempts', async () => {
    const gate = { release: null as (() => void) | null };
    const readGate = new Promise<void>(resolve => {
      gate.release = resolve;
    });
    notificationsMock.getDevicePushTokenOutcome.mockImplementation(async () => {
      await readGate;
      return { kind: 'token', token: 'push-1' };
    });
    trpcMock.getMyPushTokens.query.mockResolvedValue([]);
    trpcMock.registerPushToken.mutate.mockResolvedValue({ success: true });

    const first = attemptPushRegistrationReconciliation('u1');
    const second = attemptPushRegistrationReconciliation('u1');

    expect(await second).toEqual({ kind: 'in-flight' });
    gate.release?.();
    const firstOutcome = await first;
    expect(firstOutcome.kind).toBe('registered');
  });

  it('discards the result when the auth epoch moves during the attempt', async () => {
    notificationsMock.getDevicePushTokenOutcome.mockResolvedValue({
      kind: 'token',
      token: 'push-1',
    });
    trpcMock.getMyPushTokens.query.mockResolvedValue([]);
    const gate = { release: null as (() => void) | null };
    const registerGate = new Promise<void>(resolve => {
      gate.release = resolve;
    });
    trpcMock.registerPushToken.mutate.mockImplementation(async () => {
      await registerGate;
      return { success: true };
    });

    const attempt = attemptPushRegistrationReconciliation('u1');
    await vi.waitFor(() => {
      expect(trpcMock.registerPushToken.mutate).toHaveBeenCalled();
    });

    // A sign-out (or sign-in) advanced the epoch while the attempt was in
    // flight: the stale reconciliation must not invalidate for the wrong user.
    bumpAuthEpoch();
    gate.release?.();

    const outcome = await attempt;

    expect(outcome).toEqual({ kind: 'register-failed' });
    expect(queryClientMock.invalidateQueries).not.toHaveBeenCalled();
  });

  it('does not start registration while logout reconciliation for this sign-in is still running', async () => {
    notificationsMock.getDevicePushTokenOutcome.mockResolvedValue({
      kind: 'token',
      token: 'push-1',
    });
    trpcMock.getMyPushTokens.query.mockResolvedValue([]);
    trpcMock.registerPushToken.mutate.mockResolvedValue({ success: true });

    const gate = { release: null as (() => void) | null };
    const settledGate = new Promise<void>(resolve => {
      gate.release = resolve;
    });
    logoutMock.attemptLogoutReconciliation.mockReturnValue({ kind: 'in-flight' });
    logoutMock.awaitLogoutReconciliationSettled.mockImplementation(async () => {
      await settledGate;
    });

    const attempt = attemptPushRegistrationReconciliation('u1');

    // Flush microtasks and a macrotask: the logout unregister is still in
    // flight, so registration must not have started.
    await new Promise<void>(resolve => {
      setTimeout(resolve, 0);
    });

    expect(trpcMock.getMyPushTokens.query).not.toHaveBeenCalled();
    expect(trpcMock.registerPushToken.mutate).not.toHaveBeenCalled();

    gate.release?.();
    const outcome = await attempt;

    expect(outcome).toEqual({ kind: 'registered' });
    expect(trpcMock.registerPushToken.mutate).toHaveBeenCalled();
  });

  it('does not register when the auth epoch moves before the mutate', async () => {
    notificationsMock.getDevicePushTokenOutcome.mockResolvedValue({
      kind: 'token',
      token: 'push-1',
    });
    const gate = { release: null as (() => void) | null };
    const lookupGate = new Promise<void>(resolve => {
      gate.release = resolve;
    });
    trpcMock.getMyPushTokens.query.mockImplementation(async () => {
      await lookupGate;
      return [];
    });
    trpcMock.registerPushToken.mutate.mockResolvedValue({ success: true });

    const attempt = attemptPushRegistrationReconciliation('u1');
    await vi.waitFor(() => {
      expect(trpcMock.getMyPushTokens.query).toHaveBeenCalled();
    });

    // A sign-out advanced the epoch after the lookup but before the mutate:
    // the pre-mutate fence must stop the registration.
    bumpAuthEpoch();
    gate.release?.();

    const outcome = await attempt;

    expect(outcome).toEqual({ kind: 'register-failed' });
    expect(trpcMock.registerPushToken.mutate).not.toHaveBeenCalled();
    expect(queryClientMock.invalidateQueries).not.toHaveBeenCalled();
  });
});

describe('subscribeToPushTokenRotation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetPushRegistrationReconciliationForTests();
    logoutMock.attemptLogoutReconciliation.mockResolvedValue({ kind: 'no-tombstone' });
    logoutMock.awaitLogoutReconciliationSettled.mockResolvedValue(undefined);
    notificationsMock.getPlatform.mockReturnValue('ios');
    queryClientMock.invalidateQueries.mockResolvedValue(undefined);
  });

  it('defers a rotation event to the shared reconciliation without calling a token getter in the listener', async () => {
    notificationsMock.getDevicePushTokenOutcome.mockResolvedValue({
      kind: 'token',
      token: 'push-1',
    });
    trpcMock.getMyPushTokens.query.mockResolvedValue([]);
    trpcMock.registerPushToken.mutate.mockResolvedValue({ success: true });

    const unsubscribe = subscribeToPushTokenRotation('u1');
    expect(expoNotificationsMock.addPushTokenListener).toHaveBeenCalledTimes(1);

    const listener = expoNotificationsMock.lastListener();
    if (listener === null) {
      throw new Error('push token listener was not registered');
    }
    // Invoke the listener as Expo would, carrying a native DevicePushToken.
    listener({ type: 'android', data: 'native-fcm-token' });

    // The listener body must not call the token getter synchronously — that
    // would retrigger the event and loop.
    expect(notificationsMock.getDevicePushTokenOutcome).not.toHaveBeenCalled();

    // The deferred reconciliation runs on the next tick and registers the
    // Expo token (never the native token the event carries).
    await vi.waitFor(() => {
      expect(trpcMock.registerPushToken.mutate).toHaveBeenCalledWith({
        token: 'push-1',
        platform: 'ios',
      });
    });

    unsubscribe();
    const remove = expoNotificationsMock.lastRemove();
    if (remove === null) {
      throw new Error('subscription remove was not registered');
    }
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('never unregisters the previous token on rotation', async () => {
    notificationsMock.getDevicePushTokenOutcome.mockResolvedValue({
      kind: 'token',
      token: 'push-1',
    });
    trpcMock.getMyPushTokens.query.mockResolvedValue([]);
    trpcMock.registerPushToken.mutate.mockResolvedValue({ success: true });

    subscribeToPushTokenRotation('u1');
    const listener = expoNotificationsMock.lastListener();
    if (listener === null) {
      throw new Error('push token listener was not registered');
    }
    listener({ type: 'android', data: 'native-fcm-token' });

    await vi.waitFor(() => {
      expect(trpcMock.registerPushToken.mutate).toHaveBeenCalled();
    });

    // The stale token is left to Expo's DeviceNotRegistered pruning.
    expect(trpcMock.unregisterPushToken.mutate).not.toHaveBeenCalled();
  });
});
