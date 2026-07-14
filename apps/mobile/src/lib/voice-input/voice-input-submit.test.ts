import { describe, expect, it, vi } from 'vitest';

import { settleVoiceInputBeforeSubmit } from './voice-input-submit';

describe('settleVoiceInputBeforeSubmit', () => {
  it('rejects a duplicate submission while the first submission is settling', async () => {
    const settlement = Promise.withResolvers<boolean>();
    const lock = { current: false };
    const pendingChanges: boolean[] = [];
    const settleVoiceInput = vi.fn(async () => {
      const result = await settlement.promise;
      return result;
    });
    const submit = vi.fn<() => void>();

    const first = settleVoiceInputBeforeSubmit({
      lock,
      onPendingChange: pending => {
        pendingChanges.push(pending);
      },
      settleVoiceInput,
      submit,
    });
    const duplicate = settleVoiceInputBeforeSubmit({
      lock,
      onPendingChange: pending => {
        pendingChanges.push(pending);
      },
      settleVoiceInput,
      submit,
    });

    await expect(duplicate).resolves.toBe(false);
    expect(settleVoiceInput).toHaveBeenCalledTimes(1);
    expect(pendingChanges).toEqual([true]);

    settlement.resolve(true);
    await expect(first).resolves.toBe(true);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(pendingChanges).toEqual([true, false]);
    expect(lock.current).toBe(false);
  });

  it('keeps the submission locked until an asynchronous submit completes', async () => {
    const submission = Promise.withResolvers<boolean>();
    const lock = { current: false };
    const submit = vi.fn(async () => {
      await submission.promise;
    });

    const first = settleVoiceInputBeforeSubmit({
      lock,
      settleVoiceInput: vi.fn().mockResolvedValueOnce(true),
      submit,
    });
    await vi.waitFor(() => {
      expect(submit).toHaveBeenCalledTimes(1);
    });

    await expect(
      settleVoiceInputBeforeSubmit({
        lock,
        settleVoiceInput: vi.fn().mockResolvedValueOnce(true),
        submit,
      })
    ).resolves.toBe(false);

    submission.resolve(true);
    await expect(first).resolves.toBe(true);
  });

  it('settles before submitting and reports true', async () => {
    const order: string[] = [];

    await expect(
      settleVoiceInputBeforeSubmit({
        lock: { current: false },
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
        lock: { current: false },
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
        lock: { current: false },
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
        lock: { current: false },
        settleVoiceInput: vi.fn().mockResolvedValueOnce(true),
        submit,
      })
    ).resolves.toBe(true);

    expect(submit).toHaveBeenCalledTimes(1);
  });
});
