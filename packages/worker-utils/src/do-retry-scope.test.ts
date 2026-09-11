import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_DO_RETRY_CONFIG, withDORetry } from './do-retry.js';

afterEach(() => vi.useRealTimers());

describe('withDORetry scopes', () => {
  it('does not start another attempt after its deadline expires', async () => {
    vi.useFakeTimers();
    const operation = vi.fn(() => new Promise<never>(() => undefined));
    const pending = withDORetry(
      () => ({}),
      operation,
      'scoped_operation',
      {
        ...DEFAULT_DO_RETRY_CONFIG,
        scope: { deadlineAt: Date.now() + 100 },
      },
      { warn: () => undefined, error: () => undefined }
    );
    const outcome = pending.then(
      () => undefined,
      error => error
    );

    await vi.advanceTimersByTimeAsync(100);
    await expect(outcome).resolves.toMatchObject({ name: 'TimeoutError' });
    expect(operation).toHaveBeenCalledOnce();
  });
});
