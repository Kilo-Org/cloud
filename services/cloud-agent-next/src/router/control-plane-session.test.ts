import { describe, expect, it } from 'vitest';
import { interruptControlSession } from './control-plane-session.js';

describe('interruptControlSession', () => {
  it('maps a successful session interrupt to a confirmed local receipt', async () => {
    const getStub = () => ({
      interruptExecution: async () => ({ success: true }),
    });
    const receipt = await interruptControlSession(
      { env: {} as never, ownerId: 'user-a', sessionId: 'workspace-a' },
      { getStub, retry: async operation => operation(getStub()) }
    );
    expect(receipt).toEqual({ state: 'confirmed' });
  });

  it('maps an unconfirmed session interrupt to an unconfirmed local receipt', async () => {
    const getStub = () => ({
      interruptExecution: async () => ({
        success: false,
        unconfirmed: true,
        message: 'Session abort was not confirmed',
      }),
    });
    const receipt = await interruptControlSession(
      { env: {} as never, ownerId: 'user-a', sessionId: 'workspace-a' },
      { getStub, retry: async operation => operation(getStub()) }
    );
    expect(receipt).toEqual({
      state: 'unconfirmed',
      message: 'Session abort was not confirmed',
    });
  });

  it('maps a rejected session interrupt to a rejected local receipt with its message', async () => {
    const getStub = () => ({
      interruptExecution: async () => ({
        success: false,
        message: 'No session work to interrupt',
      }),
    });
    const receipt = await interruptControlSession(
      { env: {} as never, ownerId: 'user-a', sessionId: 'workspace-a' },
      { getStub, retry: async operation => operation(getStub()) }
    );
    expect(receipt).toEqual({ state: 'rejected', message: 'No session work to interrupt' });
  });
});
