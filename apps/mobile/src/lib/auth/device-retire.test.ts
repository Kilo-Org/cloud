import { CONTROL_PLANE_DEADLINE_MS } from '@kilocode/event-service';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const trpcMock = vi.hoisted(() => ({
  revokeCurrentDeviceSession: { mutate: vi.fn() },
  unregisterPushToken: { mutate: vi.fn() },
}));

vi.mock('@/lib/trpc', () => ({
  trpcClient: { user: trpcMock },
}));

import { retireDeviceRemoteState } from '@/lib/auth/device-retire';

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
    trpcMock.unregisterPushToken.mutate.mockImplementation(async () => {
      calls.push('push');
      return { success: true };
    });
    trpcMock.revokeCurrentDeviceSession.mutate.mockImplementation(async () => {
      calls.push('revoke');
      return { outcome: 'revoked' };
    });

    await expect(retireDeviceRemoteState('push-1')).resolves.toEqual({ status: 'fulfilled' });

    expect(calls).toEqual(['push', 'revoke']);
  });

  it('passes the shared deadline signal to both calls', async () => {
    await retireDeviceRemoteState('push-1');

    expect(trpcMock.unregisterPushToken.mutate).toHaveBeenCalledWith(
      { token: 'push-1' },
      { signal: expect.any(AbortSignal) }
    );
    expect(trpcMock.revokeCurrentDeviceSession.mutate).toHaveBeenCalledWith(
      undefined,
      { signal: expect.any(AbortSignal) }
    );
  });

  it('reports a rejected push unregister and still revokes the session', async () => {
    trpcMock.unregisterPushToken.mutate.mockRejectedValue(new Error('server 500'));

    await expect(retireDeviceRemoteState('push-1')).resolves.toEqual({ status: 'rejected' });
    expect(trpcMock.revokeCurrentDeviceSession.mutate).toHaveBeenCalledTimes(1);
  });

  it('reports a fulfilled unregister when the revoke fails', async () => {
    trpcMock.revokeCurrentDeviceSession.mutate.mockRejectedValue(new Error('network down'));

    // The revoke's own failure is never recorded: the push row is gone.
    await expect(retireDeviceRemoteState('push-1')).resolves.toEqual({ status: 'fulfilled' });
  });

  it('skips the unregister when there is no token and still revokes', async () => {
    await expect(retireDeviceRemoteState(null)).resolves.toEqual({ status: 'fulfilled' });
    expect(trpcMock.unregisterPushToken.mutate).not.toHaveBeenCalled();
    expect(trpcMock.revokeCurrentDeviceSession.mutate).toHaveBeenCalledTimes(1);
  });

  it('spends one budget for the pair instead of one per call', async () => {
    vi.useFakeTimers();
    // A stalled first call: without the shared budget the revoke would get its
    // own full window afterwards, and sign-out would wait twice as long.
    trpcMock.unregisterPushToken.mutate.mockReturnValue(new Promise<never>(() => undefined));

    const run = retireDeviceRemoteState('push-1');
    await vi.advanceTimersByTimeAsync(0);
    expect(trpcMock.unregisterPushToken.mutate).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(CONTROL_PLANE_DEADLINE_MS);
    await expect(run).resolves.toEqual({ status: 'rejected' });

    // The single budget was spent by the stalled push step, so the revoke never
    // started and could not receive a second window.
    expect(trpcMock.revokeCurrentDeviceSession.mutate).not.toHaveBeenCalled();
  });
});
