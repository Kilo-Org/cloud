import { describe, expect, it, vi } from 'vitest';

import { confirmRemoteSessionExit } from '@/components/agents/remote-session-exit-confirmation';

describe('confirmRemoteSessionExit', () => {
  it('returns cancelled without exiting', async () => {
    const exit = vi.fn(async () => {
      await Promise.resolve();
    });

    await expect(
      confirmRemoteSessionExit(async () => {
        await Promise.resolve();
        return false;
      }, exit)
    ).resolves.toBe('cancelled');
    expect(exit).not.toHaveBeenCalled();
  });

  it('calls exit once and returns accepted after it settles', async () => {
    const exit = vi.fn(async () => {
      await Promise.resolve();
    });

    await expect(
      confirmRemoteSessionExit(async () => {
        await Promise.resolve();
        return true;
      }, exit)
    ).resolves.toBe('accepted');
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('propagates exit failure', async () => {
    const error = new Error('Upgrade the CLI first');

    await expect(
      confirmRemoteSessionExit(
        async () => {
          await Promise.resolve();
          return true;
        },
        async () => {
          await Promise.resolve();
          throw error;
        }
      )
    ).rejects.toBe(error);
  });
});
