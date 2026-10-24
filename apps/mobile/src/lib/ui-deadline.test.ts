import { describe, expect, it, vi } from 'vitest';

import { isUiDeadlineError, withUiDeadline } from './ui-deadline';

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

  it('marks its own rejection so a caller keeps its message', async () => {
    vi.useFakeTimers();
    const pending = withUiDeadline(new Promise(() => undefined), 15_000);
    const rejection = expect(pending).rejects.toSatisfy(isUiDeadlineError);

    await vi.advanceTimersByTimeAsync(15_000);
    await rejection;

    expect(isUiDeadlineError(new Error('saved'))).toBe(false);
    vi.useRealTimers();
  });
});
