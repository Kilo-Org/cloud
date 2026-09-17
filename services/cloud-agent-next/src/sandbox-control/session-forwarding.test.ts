import { afterEach, describe, expect, it, vi } from 'vitest';
import { SANDBOX_CONTROL_FORWARD_OPERATION_LIMIT } from '../shared/sandbox-control-protocol.js';
import { createSessionForwarding } from './session-forwarding.js';

describe('createSessionForwarding', () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  it('keeps results behind earlier events for the same session', async () => {
    const forwarding = createSessionForwarding();
    const releaseEvent = Promise.withResolvers<void>();
    const event = vi.fn(async () => releaseEvent.promise);
    const result = vi.fn(async () => undefined);

    const first = forwarding.enqueue('workspace_1', event);
    const second = forwarding.enqueue('workspace_1', result);
    await Promise.resolve();
    expect(result).not.toHaveBeenCalled();

    releaseEvent.resolve();
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
    expect(event).toHaveBeenCalledTimes(1);
    expect(result).toHaveBeenCalledTimes(1);
  });

  it('continues a session chain after a failed forwarding attempt', async () => {
    const forwarding = createSessionForwarding();
    const failure = forwarding.enqueue('workspace_1', async () => {
      throw new Error('forwarding failed');
    });
    const recovery = vi.fn(async () => 'acknowledged');
    const next = forwarding.enqueue('workspace_1', recovery);

    await expect(failure).rejects.toThrow('forwarding failed');
    await expect(next).resolves.toBe('acknowledged');
    expect(recovery).toHaveBeenCalledTimes(1);
  });

  it('does not call a fenced delivery after its deadline', async () => {
    const forwarding = createSessionForwarding();
    const forward = vi.fn(async () => 'acknowledged');

    await expect(
      forwarding.enqueueFenced({
        sessionId: 'workspace_1',
        bytes: 1,
        deadlineAt: Date.now() - 1,
        fence: async () => true,
        forward,
      })
    ).rejects.toMatchObject({ retryable: false });
    expect(forward).not.toHaveBeenCalled();
  });

  it('rechecks the deadline after a delayed fence', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const forwarding = createSessionForwarding();
    const fence = Promise.withResolvers<boolean>();
    const forward = vi.fn(async () => 'acknowledged');
    const pending = forwarding.enqueueFenced({
      sessionId: 'workspace_1',
      bytes: 1,
      deadlineAt: 1,
      fence: async () => fence.promise,
      forward,
    });

    await Promise.resolve();
    vi.setSystemTime(2);
    fence.resolve(true);
    await expect(pending).rejects.toMatchObject({ retryable: false });
    expect(forward).not.toHaveBeenCalled();
  });

  it('rechecks the deadline after forwarding before returning a result', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const forwarding = createSessionForwarding();
    const finalFence = Promise.withResolvers<boolean>();
    let fenceCalls = 0;
    const pending = forwarding.enqueueFenced({
      sessionId: 'workspace_1',
      bytes: 1,
      deadlineAt: 1,
      fence: () => (++fenceCalls === 1 ? Promise.resolve(true) : finalFence.promise),
      forward: async () => 'acknowledged',
    });

    await Promise.resolve();
    vi.setSystemTime(2);
    finalFence.resolve(true);
    await expect(pending).rejects.toMatchObject({ retryable: false });
  });

  it('releases capacity after a pre-start fence rejection', async () => {
    const forwarding = createSessionForwarding();
    await expect(
      forwarding.enqueueFenced({
        sessionId: 'workspace_1',
        bytes: 1,
        deadlineAt: Date.now() + 1_000,
        fence: async () => false,
        forward: async () => 'unreachable',
      })
    ).rejects.toMatchObject({ retryable: false });
    expect(forwarding.stats()).toMatchObject({ waiting: 0, inFlight: 0, bufferedBytes: 0 });

    await expect(
      forwarding.enqueueFenced({
        sessionId: 'workspace_1',
        bytes: 1,
        deadlineAt: Date.now() + 1_000,
        fence: async () => true,
        forward: async () => 'acknowledged',
      })
    ).resolves.toBe('acknowledged');
    expect(forwarding.stats()).toMatchObject({ waiting: 0, inFlight: 0, bufferedBytes: 0 });
  });

  it('admits up to the forward operation limit and rejects beyond it', async () => {
    const forwarding = createSessionForwarding();
    const release = Promise.withResolvers<void>();
    const admitted: Array<Promise<unknown>> = [];
    for (let index = 0; index < SANDBOX_CONTROL_FORWARD_OPERATION_LIMIT; index++) {
      admitted.push(
        forwarding.enqueueFenced({
          sessionId: 'workspace_1',
          bytes: 1,
          deadlineAt: Date.now() + 60_000,
          fence: async () => true,
          forward: async () => release.promise,
        })
      );
    }
    expect(forwarding.stats()).toMatchObject({
      waiting: SANDBOX_CONTROL_FORWARD_OPERATION_LIMIT,
      inFlight: 0,
    });

    await expect(
      forwarding.enqueueFenced({
        sessionId: 'workspace_1',
        bytes: 1,
        deadlineAt: Date.now() + 60_000,
        fence: async () => true,
        forward: async () => 'unreachable',
      })
    ).rejects.toMatchObject({ retryable: true });

    release.resolve();
    await Promise.allSettled(admitted);
    expect(forwarding.stats()).toMatchObject({ waiting: 0, inFlight: 0, bufferedBytes: 0 });
  });

  it('keeps a detached lane until admitted work settles', async () => {
    const forwarding = createSessionForwarding();
    const release = Promise.withResolvers<void>();
    const first = forwarding.enqueue('workspace_1', async () => release.promise);
    await Promise.resolve();
    forwarding.delete('workspace_1');
    const secondForward = vi.fn(async () => 'second');
    const second = forwarding.enqueue('workspace_1', secondForward);
    await Promise.resolve();
    expect(secondForward).not.toHaveBeenCalled();
    release.resolve();
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBe('second');
    expect(secondForward).toHaveBeenCalledTimes(1);
    expect(forwarding.get('workspace_1')).toBeUndefined();
  });
});
