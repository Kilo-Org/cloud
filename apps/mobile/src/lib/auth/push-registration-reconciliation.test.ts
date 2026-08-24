/* eslint-disable max-lines -- one harness holds the reconciliation single-flight, spacing, epoch, and switch-mid-attempt suites */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

const languageMock = vi.hoisted(() => ({
  getResolvedLanguage: vi.fn(() => 'en'),
}));

/* eslint-disable import/first */
vi.mock('@/lib/auth/logout-reconciliation', () => logoutMock);
vi.mock('@/lib/notifications', () => notificationsMock);
vi.mock('@/lib/trpc', () => ({
  trpcClient: { user: trpcMock },
}));
vi.mock('@/lib/query-client', () => ({
  queryClient: queryClientMock,
}));
vi.mock('@/lib/hooks/use-language-preference', () => languageMock);
vi.mock('expo-notifications', () => ({
  addPushTokenListener: expoNotificationsMock.addPushTokenListener,
}));
vi.mock('expo-application', () => ({
  nativeApplicationVersion: '1.0.4',
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
    languageMock.getResolvedLanguage.mockReturnValue('en');
    queryClientMock.invalidateQueries.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
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

  it('returns already-registered and performs no write when the server row holds the active locale', async () => {
    notificationsMock.getDevicePushTokenOutcome.mockResolvedValue({
      kind: 'token',
      token: 'push-1',
    });
    // A null locale is English, and English is the active language.
    trpcMock.getMyPushTokens.query.mockResolvedValue([
      { token: 'push-1', platform: 'ios', locale: null },
    ]);
    trpcMock.registerPushToken.mutate.mockResolvedValue({ success: true });

    const outcome = await attemptPushRegistrationReconciliation('u1');

    expect(outcome).toEqual({ kind: 'already-registered' });
    expect(trpcMock.registerPushToken.mutate).not.toHaveBeenCalled();
    expect(queryClientMock.invalidateQueries).not.toHaveBeenCalled();
  });

  it('re-registers when the server row for this account holds a stale locale', async () => {
    // The same device keeps one Expo token across a sign-out and sign-in, so a
    // client-side "locale already sent" cache would answer already-registered
    // for a row written by, or for, a different account.
    notificationsMock.getDevicePushTokenOutcome.mockResolvedValue({
      kind: 'token',
      token: 'push-1',
    });
    trpcMock.getMyPushTokens.query.mockResolvedValue([
      { token: 'push-1', platform: 'ios', locale: 'de' },
    ]);
    trpcMock.registerPushToken.mutate.mockResolvedValue({ success: true });

    const outcome = await attemptPushRegistrationReconciliation('u2');

    expect(outcome.kind).toBe('registered');
    expect(trpcMock.registerPushToken.mutate).toHaveBeenCalledWith({
      token: 'push-1',
      platform: 'ios',
      appVersion: '1.0.4',
      locale: 'en',
    });
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
      appVersion: '1.0.4',
      locale: 'en',
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

  it('does not spacing-skip a different user within the 60 s window', async () => {
    notificationsMock.getDevicePushTokenOutcome.mockResolvedValue({
      kind: 'token',
      token: 'push-1',
    });
    trpcMock.getMyPushTokens.query.mockResolvedValue([]);
    trpcMock.registerPushToken.mutate.mockResolvedValue({ success: true });

    const first = await attemptPushRegistrationReconciliation('u1');
    const second = await attemptPushRegistrationReconciliation('u2');

    expect(first.kind).toBe('registered');
    // A sign-out then sign-in of a different user within the window must still
    // register: the spacing is per-user, so B's token is never skipped.
    expect(second.kind).toBe('registered');
    expect(trpcMock.registerPushToken.mutate).toHaveBeenCalledTimes(2);
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

  it("awaits a different user's in-flight attempt and then registers for the new user", async () => {
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
    // Wait until A's attempt is in flight (its device-token read started).
    await vi.waitFor(() => {
      expect(notificationsMock.getDevicePushTokenOutcome).toHaveBeenCalled();
    });

    // B calls while A's attempt is in flight: B must not be dropped as
    // in-flight, and must register for B after A settles.
    const second = attemptPushRegistrationReconciliation('u2');
    gate.release?.();

    expect(await first).toEqual({ kind: 'registered' });
    expect(await second).toEqual({ kind: 'registered' });
    expect(trpcMock.registerPushToken.mutate).toHaveBeenCalledTimes(2);
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

  it('bypasses the spacing skip when the resolved locale changed', async () => {
    notificationsMock.getDevicePushTokenOutcome.mockResolvedValue({
      kind: 'token',
      token: 'push-1',
    });
    trpcMock.getMyPushTokens.query.mockResolvedValue([]);
    trpcMock.registerPushToken.mutate.mockResolvedValue({ success: true });

    const first = await attemptPushRegistrationReconciliation('u1');
    expect(first.kind).toBe('registered');

    languageMock.getResolvedLanguage.mockReturnValue('es');
    const second = await attemptPushRegistrationReconciliation('u1');

    expect(second.kind).toBe('registered');
    expect(trpcMock.registerPushToken.mutate).toHaveBeenLastCalledWith({
      token: 'push-1',
      platform: 'ios',
      appVersion: '1.0.4',
      locale: 'es',
    });
  });

  it('still mutates when the token row exists but the locale changed', async () => {
    notificationsMock.getDevicePushTokenOutcome.mockResolvedValue({
      kind: 'token',
      token: 'push-1',
    });
    trpcMock.getMyPushTokens.query.mockResolvedValue([
      { token: 'push-1', platform: 'ios', locale: null },
    ]);
    trpcMock.registerPushToken.mutate.mockResolvedValue({ success: true });

    const first = await attemptPushRegistrationReconciliation('u1');
    expect(first.kind).toBe('already-registered');

    languageMock.getResolvedLanguage.mockReturnValue('es');
    const second = await attemptPushRegistrationReconciliation('u1');

    expect(second.kind).toBe('registered');
    expect(trpcMock.registerPushToken.mutate).toHaveBeenCalledWith({
      token: 'push-1',
      platform: 'ios',
      appVersion: '1.0.4',
      locale: 'es',
    });
  });

  it('retries a failed locale upsert on the next attempt', async () => {
    notificationsMock.getDevicePushTokenOutcome.mockResolvedValue({
      kind: 'token',
      token: 'push-1',
    });
    trpcMock.getMyPushTokens.query.mockResolvedValue([]);
    trpcMock.registerPushToken.mutate.mockRejectedValueOnce(new Error('server 500'));

    languageMock.getResolvedLanguage.mockReturnValue('es');
    const first = await attemptPushRegistrationReconciliation('u1');
    expect(first.kind).toBe('register-failed');

    // The failed upsert must not mark the locale as sent, so the next attempt
    // (still 'es') retries instead of spacing-skipping or already-registered.
    trpcMock.registerPushToken.mutate.mockResolvedValue({ success: true });
    const second = await attemptPushRegistrationReconciliation('u1');

    expect(second.kind).toBe('registered');
    expect(trpcMock.registerPushToken.mutate).toHaveBeenLastCalledWith({
      token: 'push-1',
      platform: 'ios',
      appVersion: '1.0.4',
      locale: 'es',
    });
  });
});

describe('subscribeToPushTokenRotation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetPushRegistrationReconciliationForTests();
    logoutMock.attemptLogoutReconciliation.mockResolvedValue({ kind: 'no-tombstone' });
    logoutMock.awaitLogoutReconciliationSettled.mockResolvedValue(undefined);
    notificationsMock.getPlatform.mockReturnValue('ios');
    languageMock.getResolvedLanguage.mockReturnValue('en');
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
        appVersion: '1.0.4',
        locale: 'en',
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
