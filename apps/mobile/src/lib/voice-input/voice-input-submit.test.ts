import { describe, expect, it, vi } from 'vitest';

import { settleVoiceInputBeforeSubmit } from './voice-input-submit';

describe('settleVoiceInputBeforeSubmit', () => {
  it('settles before submitting and reports true', async () => {
    const order: string[] = [];

    await expect(
      settleVoiceInputBeforeSubmit({
        settleVoiceInput: vi.fn().mockImplementationOnce(async () => {
          await Promise.resolve();
          order.push('settle');
          return true;
        }),
        submit: () => {
          order.push('submit');
        },
      })
    ).resolves.toBe(true);

    expect(order).toEqual(['settle', 'submit']);
  });

  it('does not submit when settlement returns false', async () => {
    const submit = vi.fn<() => void>();

    await expect(
      settleVoiceInputBeforeSubmit({
        settleVoiceInput: vi.fn().mockResolvedValueOnce(false),
        submit,
      })
    ).resolves.toBe(false);

    expect(submit).not.toHaveBeenCalled();
  });

  it('propagates settlement errors without submitting', async () => {
    const failure = new Error('native recognition crashed');
    const submit = vi.fn<() => void>();

    await expect(
      settleVoiceInputBeforeSubmit({
        settleVoiceInput: vi.fn().mockRejectedValueOnce(failure),
        submit,
      })
    ).rejects.toBe(failure);

    expect(submit).not.toHaveBeenCalled();
  });

  it('invokes submit exactly once when settlement returns true', async () => {
    const submit = vi.fn<() => void>();

    await expect(
      settleVoiceInputBeforeSubmit({
        settleVoiceInput: vi.fn().mockResolvedValueOnce(true),
        submit,
      })
    ).resolves.toBe(true);

    expect(submit).toHaveBeenCalledTimes(1);
  });
});
