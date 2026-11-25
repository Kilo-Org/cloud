import { CONTROL_PLANE_DEADLINE_MS } from '@kilocode/event-service';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const trpcMock = vi.hoisted(() => ({
  revokeCurrentDeviceSession: { mutate: vi.fn() },
  unregisterPushToken: { mutate: vi.fn() },
}));

vi.mock('@/lib/trpc', () => ({
  trpcClient: { user: trpcMock },
}));

// eslint-disable-next-line import/first -- the mock above must be hoisted first
import { retireDeviceRemoteState } from '@/lib/auth/device-retire';

// Mirrors the module's cap on the push unregister: half of the one control-plane
// budget the pair may spend in total.
const PUSH_UNREGISTER_DEADLINE_MS = Math.floor(CONTROL_PLANE_DEADLINE_MS / 2);

describe('retireDeviceRemoteState', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    trpcMock.unregisterPushToken.mutate.mockResolvedValue({ success: true });
    trpcMock.revokeCurrentDeviceSession.mutate.mockResolvedValue({ outcome: 'revoked' });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('unregisters the push token before it revokes the session', async () => {
    const calls: string[] = [];
    trpcMock.unregisterPushToken.mutate.mockImplementation(() => {
      calls.push('push');
      return Promise.resolve({ success: true });
    });
    trpcMock.revokeCurrentDeviceSession.mutate.mockImplementation(() => {
      calls.push('revoke');
      return Promise.resolve({ outcome: 'revoked' });
    });

    await expect(retireDeviceRemoteState('push-1')).resolves.toEqual({
      push: { status: 'fulfilled' },
      revoke: { status: 'revoked' },
    });

    expect(calls).toEqual(['push', 'revoke']);
  });

  it('passes the shared deadline signal to both calls', async () => {
    await retireDeviceRemoteState('push-1');

    expect(trpcMock.unregisterPushToken.mutate).toHaveBeenCalledWith(
      { token: 'push-1' },
      { signal: expect.any(AbortSignal) }
    );
    expect(trpcMock.revokeCurrentDeviceSession.mutate).toHaveBeenCalledWith(undefined, {
      signal: expect.any(AbortSignal),
    });
  });

  it('reports a rejected push unregister and still revokes the session', async () => {
    trpcMock.unregisterPushToken.mutate.mockRejectedValue(new Error('server 500'));

    await expect(retireDeviceRemoteState('push-1')).resolves.toEqual({
      push: { status: 'rejected' },
      revoke: { status: 'revoked' },
    });
    expect(trpcMock.revokeCurrentDeviceSession.mutate).toHaveBeenCalledTimes(1);
  });

  it('reports a fulfilled unregister and a retryable revoke when the revoke fails', async () => {
    trpcMock.revokeCurrentDeviceSession.mutate.mockRejectedValue(new Error('network down'));

    // The push row is gone, but the session may still be live (and with it the
    // Home widget credential), so the caller has to record the refresh token.
    await expect(retireDeviceRemoteState('push-1')).resolves.toEqual({
      push: { status: 'fulfilled' },
      revoke: { status: 'retryable' },
    });
  });

  it('treats a NOT_FOUND revoke as settled', async () => {
    trpcMock.revokeCurrentDeviceSession.mutate.mockRejectedValue({ data: { code: 'NOT_FOUND' } });

    await expect(retireDeviceRemoteState(null)).resolves.toEqual({
      push: { status: 'fulfilled' },
      revoke: { status: 'revoked' },
    });
  });

  it('treats an expired access token as retryable', async () => {
    // UNAUTHORIZED says nothing about the session row: the refresh token is
    // still the way to revoke it.
    trpcMock.revokeCurrentDeviceSession.mutate.mockRejectedValue({
      data: { code: 'UNAUTHORIZED' },
    });

    await expect(retireDeviceRemoteState(null)).resolves.toMatchObject({
      revoke: { status: 'retryable' },
    });
  });

  it('skips the unregister when there is no token and still revokes', async () => {
    await expect(retireDeviceRemoteState(null)).resolves.toEqual({
      push: { status: 'fulfilled' },
      revoke: { status: 'revoked' },
    });
    expect(trpcMock.unregisterPushToken.mutate).not.toHaveBeenCalled();
    expect(trpcMock.revokeCurrentDeviceSession.mutate).toHaveBeenCalledTimes(1);
  });

  it('keeps a fulfilled unregister when the revoke is the step that stalls', async () => {
    vi.useFakeTimers();
    // The row is already gone: the unregister answered. The revoke then hangs,
    // so the shared budget expires on the second call.
    trpcMock.revokeCurrentDeviceSession.mutate.mockReturnValue(new Promise<never>(() => undefined));

    const run = retireDeviceRemoteState('push-1');
    await vi.advanceTimersByTimeAsync(0);
    expect(trpcMock.unregisterPushToken.mutate).toHaveBeenCalledTimes(1);
    expect(trpcMock.revokeCurrentDeviceSession.mutate).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(CONTROL_PLANE_DEADLINE_MS);
    // Reporting `rejected` here would record a deletion that already succeeded
    // as still owed, and withhold the event that marks the token gone. The
    // revoke never answered, so its own outcome stays retryable.
    await expect(run).resolves.toEqual({
      push: { status: 'fulfilled' },
      revoke: { status: 'retryable' },
    });
  });

  it('abandons a stalled unregister at the push budget and still revokes once', async () => {
    vi.useFakeTimers();
    // A stalled unregister must not consume the whole budget: the device
    // session row would stay live server-side after sign-out.
    trpcMock.unregisterPushToken.mutate.mockReturnValue(new Promise<never>(() => undefined));

    let settled = false;
    const run = (async () => {
      const value = await retireDeviceRemoteState('push-1');
      settled = true;
      return value;
    })();

    await vi.advanceTimersByTimeAsync(0);
    expect(trpcMock.unregisterPushToken.mutate).toHaveBeenCalledTimes(1);
    expect(trpcMock.revokeCurrentDeviceSession.mutate).not.toHaveBeenCalled();

    // Half the budget only: the nested deadline gives up on the unregister and
    // the revoke starts on the budget that is left.
    await vi.advanceTimersByTimeAsync(PUSH_UNREGISTER_DEADLINE_MS);
    expect(trpcMock.revokeCurrentDeviceSession.mutate).toHaveBeenCalledTimes(1);
    expect(settled).toBe(true);

    // The remaining budget is never needed, so sign-out waited one half window
    // rather than a full one.
    await vi.advanceTimersByTimeAsync(CONTROL_PLANE_DEADLINE_MS - PUSH_UNREGISTER_DEADLINE_MS);
    await expect(run).resolves.toEqual({
      push: { status: 'rejected' },
      revoke: { status: 'revoked' },
    });
  });

  it('settles within one budget when both the unregister and the revoke stall', async () => {
    vi.useFakeTimers();
    // Neither call answers. Sign-out must never wait two windows: the push step
    // is abandoned at half the budget and the revoke at the end of the one
    // shared budget.
    trpcMock.unregisterPushToken.mutate.mockReturnValue(new Promise<never>(() => undefined));
    trpcMock.revokeCurrentDeviceSession.mutate.mockReturnValue(new Promise<never>(() => undefined));

    let settled = false;
    const run = (async () => {
      const value = await retireDeviceRemoteState('push-1');
      settled = true;
      return value;
    })();

    await vi.advanceTimersByTimeAsync(PUSH_UNREGISTER_DEADLINE_MS);
    expect(trpcMock.revokeCurrentDeviceSession.mutate).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(CONTROL_PLANE_DEADLINE_MS - PUSH_UNREGISTER_DEADLINE_MS);
    await expect(run).resolves.toEqual({
      push: { status: 'rejected' },
      revoke: { status: 'retryable' },
    });
  });
});
