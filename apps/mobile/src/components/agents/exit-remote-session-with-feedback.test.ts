import { describe, expect, it, vi } from 'vitest';

import { exitRemoteCliWithFeedback } from '@/components/agents/exit-remote-cli-with-feedback';

const SESSIONS_ROUTE = '/(app)/(tabs)/(2_agents)';

describe('exitRemoteCliWithFeedback', () => {
  it('calls the manager once, then success toast, then replaces with the sessions route', async () => {
    const order: string[] = [];
    const exit = vi.fn(async () => {
      order.push('exit');
      await Promise.resolve();
    });
    const onSuccess = vi.fn(() => {
      order.push('success');
    });
    const onError = vi.fn((_message: string): void => undefined);
    const onAccepted = vi.fn(() => {
      order.push('accepted');
    });
    const router = {
      replace: vi.fn(() => {
        order.push('replace');
      }),
    };

    await exitRemoteCliWithFeedback({ exit, onAccepted, onSuccess, onError, router });

    expect(exit).toHaveBeenCalledTimes(1);
    expect(onSuccess).toHaveBeenCalledWith('CLI exited');
    expect(router.replace).toHaveBeenCalledTimes(1);
    expect(router.replace).toHaveBeenCalledWith(SESSIONS_ROUTE);
    expect(onError).not.toHaveBeenCalled();
    expect(order).toEqual(['exit', 'accepted', 'success', 'replace']);
  });

  it('shows one actionable error and rethrows without success or navigation', async () => {
    const error = new Error('Upgrade Kilo Code CLI to exit remotely.');
    const exit = vi.fn(async () => {
      await Promise.resolve();
      throw error;
    });
    const onSuccess = vi.fn((_message: string): void => undefined);
    const onError = vi.fn((_message: string): void => undefined);
    const onAccepted = vi.fn((): void => undefined);
    const router = { replace: vi.fn() };

    await expect(
      exitRemoteCliWithFeedback({ exit, onAccepted, onSuccess, onError, router })
    ).rejects.toBe(error);

    expect(exit).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(error.message);
    expect(onAccepted).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
  });
});
