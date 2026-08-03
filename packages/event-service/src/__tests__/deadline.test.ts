import { describe, it, expect, vi } from 'vitest';
import {
  RequestDeadlineError,
  CONTROL_PLANE_DEADLINE_MS,
  SEND_DEADLINE_MS,
  withDeadline,
} from '../deadline';

/**
 * Hermes (React Native) whatwg-fetch rejects with a generic `AbortError`
 * DOMException after the signal aborts, discarding `signal.reason`.
 * This constant simulates that behavior in tests.
 */
const HERMES_ABORT_ERROR = new DOMException('Aborted', 'AbortError');

describe('withDeadline', () => {
  it('resolves with the return value when fn completes before the deadline', async () => {
    const result = await withDeadline(5_000, async () => 'ok');
    expect(result).toBe('ok');
  });

  it('rejects with RequestDeadlineError when the deadline expires', async () => {
    vi.useFakeTimers();
    try {
      const promise = withDeadline(100, signal => {
        return new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason));
        });
      });

      vi.advanceTimersByTime(200);
      vi.runAllTicks();

      await expect(promise).rejects.toThrow(RequestDeadlineError);
      await expect(promise).rejects.toThrow('timed out after 100ms');
    } finally {
      vi.useRealTimers();
    }
  });

  it('forwards the signal to fn', async () => {
    const signalRef: AbortSignal[] = [];

    await withDeadline(5_000, signal => {
      signalRef.push(signal);
      return Promise.resolve('ok');
    });

    expect(signalRef).toHaveLength(1);
    expect(signalRef[0]).toBeInstanceOf(AbortSignal);
    expect(signalRef[0].aborted).toBe(false);
  });

  it('clears the timer after success (no late aborts)', async () => {
    vi.useFakeTimers();

    const fn = vi.fn(async () => 'ok');
    const promise = withDeadline(10_000, fn);

    await vi.advanceTimersByTimeAsync(0);
    const result = await promise;

    expect(result).toBe('ok');

    // Advance past the deadline — the timer must be cleared, so fn is not
    // called again and no unhandled rejection is emitted.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fn).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });

  it('caller abort wins over the deadline', async () => {
    vi.useFakeTimers();
    try {
      const callerController = new AbortController();

      const promise = withDeadline(
        60_000,
        signal => {
          return new Promise<never>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason));
          });
        },
        callerController.signal
      );

      // Abort from the caller side before either settles.
      callerController.abort(new Error('caller cancelled'));

      vi.runAllTicks();

      await expect(promise).rejects.toThrow('caller cancelled');
    } finally {
      vi.useRealTimers();
    }
  });

  it('already-aborted caller signal rejects immediately', async () => {
    const callerController = new AbortController();
    callerController.abort(new Error('already aborted'));

    const fn = vi.fn(async () => 'never');

    await expect(withDeadline(60_000, fn, callerController.signal)).rejects.toThrow(
      'already aborted'
    );

    expect(fn).not.toHaveBeenCalled();
  });

  it('removes the caller abort listener after fn settles', async () => {
    const callerController = new AbortController();
    const removeSpy = vi.spyOn(callerController.signal, 'removeEventListener');

    await withDeadline(5_000, async () => 'ok', callerController.signal);

    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('does not add abort listener when no caller signal is provided', async () => {
    const addSpy = vi.spyOn(AbortSignal.prototype, 'addEventListener');
    const removeSpy = vi.spyOn(AbortSignal.prototype, 'removeEventListener');

    await withDeadline(5_000, async () => 'ok');

    // Neither addEventListener nor removeEventListener should be called
    // because there is no caller signal.
    expect(addSpy).not.toHaveBeenCalled();
    expect(removeSpy).not.toHaveBeenCalled();
  });
});

describe('Hermes AbortError resilience', () => {
  it('rejects with RequestDeadlineError when fn rejects generic AbortError after deadline', async () => {
    vi.useFakeTimers();
    try {
      const promise = withDeadline(100, signal => {
        return new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            // Hermes whatwg-fetch: discards signal.reason, rejects with
            // generic DOMException('Aborted', 'AbortError').
            reject(HERMES_ABORT_ERROR);
          });
        });
      });

      vi.advanceTimersByTime(200);
      vi.runAllTicks();

      await expect(promise).rejects.toThrow(RequestDeadlineError);
      await expect(promise).rejects.toThrow('timed out after 100ms');
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves caller abort reason when fn rejects generic AbortError', async () => {
    const callerController = new AbortController();

    const promise = withDeadline(
      60_000,
      signal => {
        return new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            // Hermes whatwg-fetch: discards signal.reason.
            reject(HERMES_ABORT_ERROR);
          });
        });
      },
      callerController.signal
    );

    callerController.abort(new Error('caller cancelled'));

    await expect(promise).rejects.toThrow('caller cancelled');
    // Must not be the generic AbortError.
    await expect(promise).rejects.not.toThrow('Aborted');
  });

  it('does not leak unhandled rejection when inner promise rejects after outer settles', async () => {
    vi.useFakeTimers();
    try {
      // The inner promise (simulating Hermes whatwg-fetch) rejects with a
      // generic AbortError after the deadline timer fires. The settle gate
      // must suppress this rejection so it does not propagate to the outer
      // promise, which already rejected with RequestDeadlineError.
      const promise = withDeadline(100, signal => {
        return new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            reject(HERMES_ABORT_ERROR);
          });
        });
      });

      // Timer fires, outer rejects with RequestDeadlineError.
      vi.advanceTimersByTime(200);
      vi.runAllTicks();

      // The outer promise must have rejected with the deadline error,
      // not the generic AbortError.
      await expect(promise).rejects.toThrow(RequestDeadlineError);
      await expect(promise).rejects.not.toThrow('Aborted');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not leak timer or listener when fn rejects generic AbortError after deadline', async () => {
    vi.useFakeTimers();
    try {
      const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');

      const promise = withDeadline(100, signal => {
        return new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            reject(HERMES_ABORT_ERROR);
          });
        });
      });

      vi.advanceTimersByTime(200);
      vi.runAllTicks();

      await expect(promise).rejects.toThrow(RequestDeadlineError);

      // clearTimeout must have been called (even though the timer already
      // fired, the finally block still clears it for safety).
      expect(clearTimeoutSpy).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('successful fn still resolves normally alongside Hermes sim', async () => {
    // Regression: normal resolution must work even with the new
    // independent-settlement pattern.
    const result = await withDeadline(5_000, async () => {
      // Return a value — no abort involved.
      return 42;
    });

    expect(result).toBe(42);
  });
});

describe('RequestDeadlineError', () => {
  it('is an instance of Error', () => {
    const err = new RequestDeadlineError(10_000);
    expect(err).toBeInstanceOf(Error);
  });

  it('has name RequestDeadlineError', () => {
    const err = new RequestDeadlineError(10_000);
    expect(err.name).toBe('RequestDeadlineError');
  });

  it('includes the deadline in its message', () => {
    const err = new RequestDeadlineError(15_000);
    expect(err.message).toContain('15000');
  });
});

describe('CONTROL_PLANE_DEADLINE_MS', () => {
  it('is 15 seconds', () => {
    expect(CONTROL_PLANE_DEADLINE_MS).toBe(15_000);
  });
});

describe('SEND_DEADLINE_MS', () => {
  it('is 30 seconds', () => {
    expect(SEND_DEADLINE_MS).toBe(30_000);
  });
});

describe('forbidden APIs', () => {
  it('never calls AbortSignal.timeout or AbortSignal.any', async () => {
    // withDeadline must use manual AbortController + setTimeout, not the
    // newer AbortSignal.timeout / AbortSignal.any static methods, because
    // those are absent on Hermes (React Native iOS/Android).
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const anySpy = vi.spyOn(AbortSignal, 'any');

    try {
      await withDeadline(5_000, async () => 'ok');
      expect(timeoutSpy).not.toHaveBeenCalled();
      expect(anySpy).not.toHaveBeenCalled();
    } finally {
      timeoutSpy.mockRestore();
      anySpy.mockRestore();
    }
  });

  it('never calls AbortSignal.timeout or AbortSignal.any with a caller signal', async () => {
    const callerController = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const anySpy = vi.spyOn(AbortSignal, 'any');

    try {
      await withDeadline(5_000, async () => 'ok', callerController.signal);
      expect(timeoutSpy).not.toHaveBeenCalled();
      expect(anySpy).not.toHaveBeenCalled();
    } finally {
      timeoutSpy.mockRestore();
      anySpy.mockRestore();
    }
  });
});
