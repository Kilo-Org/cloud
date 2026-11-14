import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DrainSessionError } from '../../../wrapper/src/kilo-api.js';
import {
  createDrainWaiter,
  DRAIN_TRANSIENT_FAILURE_LIMIT,
  type DrainWaiter,
} from '../../../wrapper/src/drain-wait.js';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function transient(): DrainSessionError {
  return new DrainSessionError('transient', 'HTTP 503', { status: 503 });
}

describe('createDrainWaiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('diagnoses each attempt with elapsed time and the bounded underlying socket cause', async () => {
    const onFailure = vi.fn();
    const cause = Object.assign(new Error('socket connection closed'), { code: 'ECONNRESET' });
    const drain = vi
      .fn<(signal: AbortSignal) => Promise<boolean>>()
      .mockImplementationOnce(async () => {
        await new Promise(resolve => setTimeout(resolve, 50));
        throw new DrainSessionError('transient', 'Kilo v2 drain request failed', {
          cause: new TypeError('fetch failed', { cause }),
        });
      })
      .mockRejectedValueOnce(new DrainSessionError('transient', 'HTTP 503', { status: 503 }))
      .mockResolvedValue(true);
    const result = createDrainWaiter(drain, { onFailure }).start();
    await vi.advanceTimersByTimeAsync(3_050);
    await expect(result).resolves.toEqual({ state: 'drained' });
    expect(onFailure.mock.calls.map(([diagnostic]) => diagnostic)).toEqual([
      {
        attempt: 1,
        elapsedMs: 50,
        kind: 'transient',
        errors: [
          { name: 'DrainSessionError', message: 'Kilo v2 drain request failed' },
          { name: 'TypeError', message: 'fetch failed' },
          { name: 'Error', message: 'socket connection closed', code: 'ECONNRESET' },
        ],
      },
      {
        attempt: 2,
        elapsedMs: 0,
        kind: 'transient',
        errors: [{ name: 'DrainSessionError', message: 'HTTP 503', status: 503 }],
      },
    ]);
  });

  it('redacts credentials, URLs, and response bodies and bounds cyclic causes', async () => {
    const cause = new Error(
      'Authorization: Basic synthetic-credential\nhttps://localhost/?token=synthetic-query ' +
        'x'.repeat(512)
    );
    cause.cause = cause;
    const onFailure = vi.fn();
    const waiter = createDrainWaiter(
      async () => {
        throw new DrainSessionError('definitive', 'request failed', { cause });
      },
      { onFailure }
    );
    await waiter.start();
    const diagnostic = onFailure.mock.calls[0][0];
    expect(diagnostic.errors).toHaveLength(4);
    expect(JSON.stringify(diagnostic)).not.toContain('synthetic-credential');
    expect(JSON.stringify(diagnostic)).not.toContain('synthetic-query');
    expect(
      diagnostic.errors.every((error: { message: string }) => error.message.length <= 256)
    ).toBe(true);
    for (const name of ['ZodError', 'SyntaxError']) {
      const responseError = new Error('synthetic-private-body');
      responseError.name = name;
      await createDrainWaiter(
        async () => {
          throw new DrainSessionError('anomalous', 'invalid result', { cause: responseError });
        },
        { onFailure }
      ).start();
    }
    expect(JSON.stringify(onFailure.mock.calls)).not.toContain('synthetic-private-body');
  });

  it('retries a settled transient only after the 1s backoff and can then drain', async () => {
    const second = deferred<boolean>();
    const drain = vi
      .fn<(signal: AbortSignal) => Promise<boolean>>()
      .mockRejectedValueOnce(transient())
      .mockReturnValueOnce(second.promise);
    const waiter = createDrainWaiter(drain);
    const result = waiter.start();
    let settled = false;
    void result.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(drain).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(999);
    expect(drain).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(drain).toHaveBeenCalledTimes(2);
    second.resolve(true);

    await expect(result).resolves.toEqual({ state: 'drained' });
  });

  it('settles failed on the third fast transient with 1s then 2s backoff and no fourth call', async () => {
    const drain = vi.fn<(signal: AbortSignal) => Promise<boolean>>().mockRejectedValue(transient());
    const waiter = createDrainWaiter(drain);
    const result = waiter.start();

    await vi.advanceTimersByTimeAsync(0);
    expect(drain).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(drain).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(drain).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(drain).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(drain).toHaveBeenCalledTimes(3);

    await expect(result).resolves.toEqual({
      state: 'failed',
      reason: 'Session drain failed: HTTP 503',
      kind: 'transient',
      exhaustedTransient: true,
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(drain).toHaveBeenCalledTimes(3);
    expect(DRAIN_TRANSIENT_FAILURE_LIMIT).toBe(3);
  });

  it('leaves a quiet pending call pending past 15 minutes without aborting its signal', async () => {
    const pending = deferred<boolean>();
    let signal: AbortSignal | undefined;
    const drain = vi.fn<(signal: AbortSignal) => Promise<boolean>>().mockImplementation(input => {
      signal = input;
      return pending.promise;
    });
    const waiter = createDrainWaiter(drain);
    const result = waiter.start();
    let settled = false;
    void result.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    expect(signal?.aborted).toBe(false);
    expect(settled).toBe(false);
    expect(drain).toHaveBeenCalledTimes(1);

    waiter.cancel();
  });

  it('resets the counter to 1 for a settled transient that was pending >= 30s', async () => {
    const slow = deferred<boolean>();
    const next = deferred<boolean>();
    const drain = vi
      .fn<(signal: AbortSignal) => Promise<boolean>>()
      .mockRejectedValueOnce(transient())
      .mockRejectedValueOnce(transient())
      .mockReturnValueOnce(slow.promise)
      .mockReturnValueOnce(next.promise);
    const waiter = createDrainWaiter(drain);
    const result = waiter.start();

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(drain).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(30_000);
    slow.reject(transient());
    await vi.advanceTimersByTimeAsync(0);
    expect(drain).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(drain).toHaveBeenCalledTimes(4);
    next.resolve(true);
    await expect(result).resolves.toEqual({ state: 'drained' });
  });

  it('bounds Cloud paired attempts even when each native wait lasts longer than 30 seconds', async () => {
    const drain = vi
      .fn<(signal: AbortSignal) => Promise<boolean>>()
      .mockImplementation(
        () => new Promise((_resolve, reject) => setTimeout(() => reject(transient()), 31_000))
      );
    const waiter = createDrainWaiter(drain, { slowFailureResetMs: Infinity });
    const result = waiter.start();
    await vi.advanceTimersByTimeAsync(31_000 * 3 + 1_000 + 2_000);
    await expect(result).resolves.toMatchObject({
      state: 'failed',
      kind: 'transient',
      exhaustedTransient: true,
    });
    expect(drain).toHaveBeenCalledTimes(3);
    expect(waiter.active).toBe(false);
  });

  it('increments rather than resetting for a settled transient of 29_999ms', async () => {
    const slow = deferred<boolean>();
    const drain = vi
      .fn<(signal: AbortSignal) => Promise<boolean>>()
      .mockRejectedValueOnce(transient())
      .mockRejectedValueOnce(transient())
      .mockReturnValueOnce(slow.promise)
      .mockResolvedValue(true);
    const waiter = createDrainWaiter(drain);
    const result = waiter.start();

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(29_999);
    slow.reject(transient());
    await vi.advanceTimersByTimeAsync(0);

    await expect(result).resolves.toEqual({
      state: 'failed',
      reason: 'Session drain failed: HTTP 503',
      kind: 'transient',
      exhaustedTransient: true,
    });
    expect(drain).toHaveBeenCalledTimes(3);
  });

  it('cancel during backoff starts no further call and a later start is a new operation', async () => {
    const second = deferred<boolean>();
    const drain = vi
      .fn<(signal: AbortSignal) => Promise<boolean>>()
      .mockRejectedValueOnce(transient())
      .mockReturnValueOnce(second.promise);
    const waiter = createDrainWaiter(drain);
    const result = waiter.start();

    await vi.advanceTimersByTimeAsync(0);
    expect(drain).toHaveBeenCalledTimes(1);

    waiter.cancel();
    await expect(result).resolves.toEqual({ state: 'cancelled' });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(drain).toHaveBeenCalledTimes(1);

    const next = waiter.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(drain).toHaveBeenCalledTimes(2);
    second.resolve(true);
    await expect(next).resolves.toEqual({ state: 'drained' });
  });

  it('start while in flight or in backoff adds no call and skips no delay', async () => {
    const pending = deferred<boolean>();
    const drain = vi
      .fn<(signal: AbortSignal) => Promise<boolean>>()
      .mockReturnValueOnce(pending.promise)
      .mockRejectedValueOnce(transient())
      .mockReturnValueOnce(deferred<boolean>().promise);
    const waiter = createDrainWaiter(drain);
    const result = waiter.start();

    const joined = waiter.start();
    expect(joined).toBe(result);
    await vi.advanceTimersByTimeAsync(0);
    expect(drain).toHaveBeenCalledTimes(1);

    pending.reject(transient());
    await vi.advanceTimersByTimeAsync(0);
    const joinedBackoff = waiter.start();
    expect(joinedBackoff).toBe(result);
    await vi.advanceTimersByTimeAsync(999);
    expect(drain).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(drain).toHaveBeenCalledTimes(2);

    waiter.cancel();
  });

  it('treats a returned false as an anomalous failure with the contract message', async () => {
    const drain = vi.fn<(signal: AbortSignal) => Promise<boolean>>().mockResolvedValue(false);
    const waiter: DrainWaiter = createDrainWaiter(drain);
    await expect(waiter.start()).resolves.toEqual({
      state: 'failed',
      reason: 'Session drain returned false',
      kind: 'anomalous',
      exhaustedTransient: false,
    });
  });

  it('passes a generic throw through as unclassified without parsing a status', async () => {
    const drain = vi
      .fn<(signal: AbortSignal) => Promise<boolean>>()
      .mockRejectedValue(new Error('socket exploded'));
    const waiter = createDrainWaiter(drain);
    await expect(waiter.start()).resolves.toEqual({
      state: 'failed',
      reason: 'Session drain failed: socket exploded',
      kind: 'unclassified',
      exhaustedTransient: false,
    });
  });
});
