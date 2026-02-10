import { describe, it, expect, vi } from 'vitest';
import { withDORetry, type DORetryConfig } from './do-retry';

const fastConfig: DORetryConfig = {
  maxAttempts: 3,
  baseBackoffMs: 1,
  maxBackoffMs: 10,
};

function retryableError(message: string): Error {
  const err = new Error(message);
  (err as Error & { retryable: boolean }).retryable = true;
  return err;
}

describe('withDORetry', () => {
  it('returns result on first success', async () => {
    const getStub = vi.fn(() => 'stub');
    const operation = vi.fn(async () => 42);

    const result = await withDORetry(getStub, operation, 'test-op', fastConfig);

    expect(result).toBe(42);
    expect(getStub).toHaveBeenCalledTimes(1);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(operation).toHaveBeenCalledWith('stub');
  });

  it('retries on retryable error and succeeds', async () => {
    let attempt = 0;
    const getStub = vi.fn(() => `stub-${++attempt}`);
    const operation = vi.fn(async (stub: string) => {
      if (stub === 'stub-1') throw retryableError('transient');
      return stub;
    });

    const result = await withDORetry(getStub, operation, 'test-op', fastConfig);

    expect(result).toBe('stub-2');
    expect(getStub).toHaveBeenCalledTimes(2);
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('creates a fresh stub for each retry attempt', async () => {
    const stubs: string[] = [];
    let call = 0;
    const getStub = vi.fn(() => {
      const s = `stub-${call++}`;
      stubs.push(s);
      return s;
    });
    const operation = vi.fn(async (stub: string) => {
      if (stub !== 'stub-2') throw retryableError('fail');
      return 'ok';
    });

    await withDORetry(getStub, operation, 'test-op', fastConfig);

    expect(stubs).toEqual(['stub-0', 'stub-1', 'stub-2']);
  });

  it('throws after all retry attempts exhausted', async () => {
    const getStub = vi.fn(() => 'stub');
    const operation = vi.fn(async () => {
      throw retryableError('always fails');
    });

    await expect(withDORetry(getStub, operation, 'test-op', fastConfig)).rejects.toThrow(
      'always fails'
    );

    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('throws immediately for non-retryable error without retrying', async () => {
    const getStub = vi.fn(() => 'stub');
    const operation = vi.fn(async () => {
      throw new Error('permanent failure');
    });

    await expect(withDORetry(getStub, operation, 'test-op', fastConfig)).rejects.toThrow(
      'permanent failure'
    );

    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('wraps non-Error thrown values in an Error', async () => {
    const getStub = vi.fn(() => 'stub');
    const operation = vi.fn(async () => {
      throw 'string error';
    });

    await expect(withDORetry(getStub, operation, 'test-op', fastConfig)).rejects.toThrow(
      'string error'
    );
  });

  it('respects maxAttempts config', async () => {
    const singleAttempt: DORetryConfig = { maxAttempts: 1, baseBackoffMs: 1, maxBackoffMs: 10 };
    const getStub = vi.fn(() => 'stub');
    const operation = vi.fn(async () => {
      throw retryableError('fail');
    });

    await expect(withDORetry(getStub, operation, 'test-op', singleAttempt)).rejects.toThrow('fail');

    expect(operation).toHaveBeenCalledTimes(1);
  });
});
