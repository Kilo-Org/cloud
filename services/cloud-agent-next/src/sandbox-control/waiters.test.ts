import { afterEach, describe, expect, it, vi } from 'vitest';
import { createControlRequestWaiters } from './waiters.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('control request waiters', () => {
  it('settles a pending waiter with the matching response', async () => {
    const waiters = createControlRequestWaiters();
    const pending = waiters.wait('req_1');
    expect(waiters.settle({ type: 'response', requestId: 'req_1', ok: true })).toBe(true);
    await expect(pending).resolves.toEqual({ type: 'response', requestId: 'req_1', ok: true });
    expect(waiters.pendingCount()).toBe(0);
  });

  it('ignores responses with no waiter', () => {
    const waiters = createControlRequestWaiters();
    expect(waiters.settle({ type: 'response', requestId: 'missing', ok: true })).toBe(false);
  });

  it('rejects a duplicate requestId', async () => {
    const waiters = createControlRequestWaiters();
    const first = waiters.wait('req_1');
    await expect(waiters.wait('req_1')).rejects.toMatchObject({
      message: 'Duplicate requestId',
      retryable: true,
    });
    waiters.rejectAll('cleanup');
    await expect(first).rejects.toMatchObject({ retryable: true });
  });

  it('rejects every pending waiter without creating durable state', async () => {
    const waiters = createControlRequestWaiters();
    const first = waiters.wait('req_1');
    const second = waiters.wait('req_2');
    waiters.rejectAll('Wrapper socket closed');
    await expect(first).rejects.toMatchObject({ code: 'not_ready', retryable: true });
    await expect(second).rejects.toMatchObject({ code: 'not_ready', retryable: true });
    expect(waiters.pendingCount()).toBe(0);
  });

  it('uses a per-request timeout override', async () => {
    vi.useFakeTimers();
    const waiters = createControlRequestWaiters(1_000);
    const pending = waiters.wait('req_override', 20);
    const expectation = expect(pending).rejects.toMatchObject({
      message: 'sandbox control request timeout',
    });
    await vi.advanceTimersByTimeAsync(20);
    await expectation;
  });

  it('times out a waiter', async () => {
    vi.useFakeTimers();
    const waiters = createControlRequestWaiters(20);
    const pending = waiters.wait('req_timeout');
    const expectation = expect(pending).rejects.toMatchObject({
      message: 'sandbox control request timeout',
      retryable: true,
    });
    await vi.advanceTimersByTimeAsync(20);
    await expectation;
    expect(waiters.pendingCount()).toBe(0);
  });
});
