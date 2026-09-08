import type { StateAdapter } from 'chat';
import { withChatInstallationLock } from './installation-lock';

describe('withChatInstallationLock', () => {
  it('prevents a replacement from interleaving before rejected state cleanup completes', async () => {
    let held = false;
    const extendLock = jest.fn(async () => held);
    const state = {
      acquireLock: async (threadId: string) => {
        if (held) return null;
        held = true;
        return { threadId, token: 'token', expiresAt: Date.now() + 5 * 60_000 };
      },
      extendLock,
      releaseLock: async () => {
        held = false;
      },
    } satisfies Pick<StateAdapter, 'acquireLock' | 'extendLock' | 'releaseLock'>;
    let releaseCleanup: (() => void) | undefined;
    const cleanupBarrier = new Promise<void>(resolve => {
      releaseCleanup = resolve;
    });
    let markCleanupStarted: (() => void) | undefined;
    const cleanupStarted = new Promise<void>(resolve => {
      markCleanupStarted = resolve;
    });
    const first = withChatInstallationLock(state, 'slack', 'T1', async () => {
      markCleanupStarted?.();
      await cleanupBarrier;
    });
    await cleanupStarted;
    const replacement = jest.fn();

    const replacementAttempt = withChatInstallationLock(state, 'slack', 'T1', async () =>
      replacement()
    );
    await Promise.resolve();
    expect(replacement).not.toHaveBeenCalled();
    releaseCleanup?.();
    await expect(first).resolves.toBeUndefined();
    await expect(replacementAttempt).resolves.toBeUndefined();
    expect(replacement).toHaveBeenCalledTimes(1);
  });

  it('extends the provider lock while a critical section crosses the heartbeat window', async () => {
    jest.useFakeTimers();
    const lock = { threadId: 'lock', token: 'token', expiresAt: Date.now() + 5 * 60_000 };
    const state = {
      acquireLock: jest.fn(async () => lock),
      extendLock: jest.fn(async () => true),
      releaseLock: jest.fn(async () => undefined),
    } satisfies Pick<StateAdapter, 'acquireLock' | 'extendLock' | 'releaseLock'>;
    let release: (() => void) | undefined;
    const barrier = new Promise<void>(resolve => {
      release = resolve;
    });
    const running = withChatInstallationLock(state, 'linear', 'L1', async () => barrier);

    await jest.advanceTimersByTimeAsync(10_001);
    expect(state.extendLock).toHaveBeenCalledWith(lock, 5 * 60_000);
    release?.();
    await expect(running).resolves.toBeUndefined();
    expect(state.releaseLock).toHaveBeenCalledWith(lock);
    jest.useRealTimers();
  });
});
