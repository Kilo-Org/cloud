import { describe, expect, it, vi } from 'vitest';
import { interruptControlSession } from './control-plane-session.js';

describe('interruptControlSession', () => {
  it('stops the session and returns a confirmed receipt when work was open', async () => {
    const stop = vi.fn(async () => ({ interrupted: true }));
    const getStub = () => ({ stop });
    const receipt = await interruptControlSession(
      { env: {} as never, ownerId: 'user-a', sessionId: 'workspace-a' },
      { getStub, retry: async operation => operation(getStub()) }
    );
    expect(stop).toHaveBeenCalledOnce();
    expect(receipt).toEqual({ state: 'confirmed' });
  });

  it('always calls stop and returns no receipt when there was no open work', async () => {
    const stop = vi.fn(async () => ({ interrupted: false }));
    const getStub = () => ({ stop });
    const receipt = await interruptControlSession(
      { env: {} as never, ownerId: 'user-a', sessionId: 'workspace-a' },
      { getStub, retry: async operation => operation(getStub()) }
    );
    expect(stop).toHaveBeenCalledOnce();
    expect(receipt).toBeUndefined();
  });
});
