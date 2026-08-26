/** @jest-environment jsdom */
import { act, renderHook } from '@testing-library/react';

import { executeRows, useRowExecutor, type RowOutcome } from './rowExecutor';

/** Manually-resolvable promise, so tests can control ordering precisely. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('executeRows', () => {
  it('processes rows strictly sequentially, never starting the next before the previous settles', async () => {
    const rows = ['a', 'b', 'c'];
    const deferreds = rows.map(() => deferred<void>());
    let activeCount = 0;
    let maxConcurrent = 0;
    const callOrder: string[] = [];

    const execute = jest.fn(async (row: string) => {
      callOrder.push(row);
      activeCount += 1;
      maxConcurrent = Math.max(maxConcurrent, activeCount);
      const index = rows.indexOf(row);
      await deferreds[index].promise;
      activeCount -= 1;
    });

    const updates: Array<[number, RowOutcome]> = [];
    const runPromise = executeRows(rows, [0, 1, 2], execute, (index, outcome) => {
      updates.push([index, outcome]);
    });

    // Only the first row should have started.
    await Promise.resolve();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(['a']);

    deferreds[0].resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(execute).toHaveBeenCalledTimes(2);
    expect(callOrder).toEqual(['a', 'b']);

    deferreds[1].resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(execute).toHaveBeenCalledTimes(3);
    expect(callOrder).toEqual(['a', 'b', 'c']);

    deferreds[2].resolve();
    await runPromise;

    expect(maxConcurrent).toBe(1);
    expect(updates).toEqual([
      [0, { status: 'running' }],
      [0, { status: 'succeeded' }],
      [1, { status: 'running' }],
      [1, { status: 'succeeded' }],
      [2, { status: 'running' }],
      [2, { status: 'succeeded' }],
    ]);
  });

  it('records a rejection as failed without blocking subsequent rows', async () => {
    const rows = ['a', 'b', 'c'];
    const execute = jest
      .fn<Promise<void>, [string]>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('seat limit reached'))
      .mockResolvedValueOnce(undefined);

    const updates: Array<[number, RowOutcome]> = [];
    await executeRows(rows, [0, 1, 2], execute, (index, outcome) => {
      updates.push([index, outcome]);
    });

    expect(execute).toHaveBeenCalledTimes(3);
    expect(updates).toEqual([
      [0, { status: 'running' }],
      [0, { status: 'succeeded' }],
      [1, { status: 'running' }],
      [1, { status: 'failed', error: 'seat limit reached' }],
      [2, { status: 'running' }],
      [2, { status: 'succeeded' }],
    ]);
  });

  it('only processes the given indices, leaving other rows untouched', async () => {
    const rows = ['a', 'b', 'c'];
    const execute = jest.fn().mockResolvedValue(undefined);
    const updates: Array<[number, RowOutcome]> = [];

    await executeRows(rows, [1], execute, (index, outcome) => {
      updates.push([index, outcome]);
    });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith('b');
    expect(updates).toEqual([
      [1, { status: 'running' }],
      [1, { status: 'succeeded' }],
    ]);
  });

  it('falls back to a generic message when the rejection is not an Error instance', async () => {
    const rows = ['a'];
    const execute = jest.fn().mockRejectedValue('boom');
    const updates: Array<[number, RowOutcome]> = [];

    await executeRows(rows, [0], execute, (index, outcome) => {
      updates.push([index, outcome]);
    });

    expect(updates).toEqual([
      [0, { status: 'running' }],
      [0, { status: 'failed', error: 'Something went wrong' }],
    ]);
  });
});

describe('retry-failed semantics (via executeRows called with only failed indices)', () => {
  it('reissues only the previously-failed subset, leaving succeeded rows alone', async () => {
    const rows = ['a', 'b', 'c'];
    // First pass: b fails.
    const firstExecute = jest
      .fn<Promise<void>, [string]>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('transient error'))
      .mockResolvedValueOnce(undefined);
    const outcomes: RowOutcome[] = rows.map(() => ({ status: 'pending' }));
    await executeRows(rows, [0, 1, 2], firstExecute, (index, outcome) => {
      outcomes[index] = outcome;
    });
    expect(outcomes.map(o => o.status)).toEqual(['succeeded', 'failed', 'succeeded']);

    // Retry: only the failed index (1) is reissued.
    const failedIndices = outcomes.flatMap((outcome, index) =>
      outcome.status === 'failed' ? [index] : []
    );
    expect(failedIndices).toEqual([1]);

    const retryExecute = jest.fn().mockResolvedValue(undefined);
    await executeRows(rows, failedIndices, retryExecute, (index, outcome) => {
      outcomes[index] = outcome;
    });

    expect(retryExecute).toHaveBeenCalledTimes(1);
    expect(retryExecute).toHaveBeenCalledWith('b');
    expect(outcomes.map(o => o.status)).toEqual(['succeeded', 'succeeded', 'succeeded']);
  });
});

describe('useRowExecutor progress', () => {
  it('counts a skipped row as completed immediately, without running it', () => {
    const execute = jest.fn().mockResolvedValue(undefined);
    const skip = (row: string) => (row === 'b' ? 'already a member' : null);
    const { result } = renderHook(() => useRowExecutor(['a', 'b'], skip, execute));

    expect(result.current.outcomes).toEqual([
      { status: 'pending' },
      { status: 'skipped', reason: 'already a member' },
    ]);
    expect(result.current.progress).toEqual({ completed: 1, total: 2 });
  });

  it('reaches completed === total once a run with a skipped row finishes', async () => {
    const execute = jest.fn().mockResolvedValue(undefined);
    const skip = (row: string) => (row === 'b' ? 'already a member' : null);
    const { result } = renderHook(() => useRowExecutor(['a', 'b'], skip, execute));

    await act(async () => {
      result.current.start();
    });

    // Regression check: before the fix, a skipped row was excluded from
    // `completed` but still counted in `total`, so this could never be
    // true and the results view stayed stuck on "queued" forever.
    expect(result.current.progress).toEqual({ completed: 2, total: 2 });
    expect(result.current.isRunning).toBe(false);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith('a');
  });
});
