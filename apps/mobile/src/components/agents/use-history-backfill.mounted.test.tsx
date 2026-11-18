import { describe, expect, it, vi } from 'vitest';

import { createOperationCoordinator } from './use-history-backfill';

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('createOperationCoordinator', () => {
  it('serializes a queued operation behind an in-flight one', async () => {
    const coordinator = createOperationCoordinator();
    const resolveFirst: { current: (() => void) | undefined } = { current: undefined };
    const firstResult = new Promise<void>(resolve => {
      resolveFirst.current = resolve;
    });
    const first = vi.fn().mockReturnValue(firstResult);
    const second = vi.fn().mockResolvedValue(undefined);

    // First operation starts immediately (queue empty).
    const firstRun = coordinator(first);
    expect(first).toHaveBeenCalledTimes(1);
    expect(resolveFirst.current).toBeDefined();

    // Second operation enqueued behind it must not start while it is in flight.
    const secondRun = coordinator(second);
    await flushMicrotasks();
    expect(second).not.toHaveBeenCalled();

    resolveFirst.current?.();
    await firstRun;
    await secondRun;
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('keeps the queue usable after a failed operation', async () => {
    const coordinator = createOperationCoordinator();
    const first = vi.fn().mockRejectedValue(new Error('failed'));
    const second = vi.fn().mockResolvedValue(undefined);

    await expect(coordinator(first)).rejects.toThrow('failed');
    await flushMicrotasks();

    await coordinator(second);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('runs a queued operation even when the predecessor rejects mid-queue', async () => {
    const coordinator = createOperationCoordinator();
    const first = vi.fn().mockRejectedValue(new Error('boom'));
    const second = vi.fn().mockResolvedValue(undefined);

    const firstRun = coordinator(first);
    const secondRun = coordinator(second);
    await expect(firstRun).rejects.toThrow('boom');
    await secondRun;
    expect(second).toHaveBeenCalledTimes(1);
  });
});
