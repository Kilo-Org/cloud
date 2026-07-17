import { describe, expect, it, vi } from 'vitest';

import { withUiDeadline } from './ui-deadline';

describe('withUiDeadline', () => {
  it('returns a result that settles before the deadline', async () => {
    await expect(withUiDeadline(Promise.resolve('saved'), 15_000)).resolves.toBe('saved');
  });

  it('releases the UI when an operation does not settle', async () => {
    vi.useFakeTimers();
    const result = withUiDeadline(new Promise(() => undefined), 15_000);
    const expectation = expect(result).rejects.toThrow('This is taking longer than expected');

    await vi.advanceTimersByTimeAsync(15_000);

    await expectation;
    vi.useRealTimers();
  });
});
