/* eslint-disable @typescript-eslint/promise-function-async, require-await -- The confirm stub hands the composer an unsettled Promise the test answers from outside, so it cannot await anything. */
import { describe, expect, it, vi } from 'vitest';

import { executeChatComposerSubmission } from '@/components/agents/chat-composer-submission';
import { createSubmitLock, type SubmitLock } from '@/lib/submit-lock';
import { settleVoiceInputBeforeSubmit } from '@/lib/voice-input/voice-input-submit';

/**
 * The exit confirm the composer hands to `executeChatComposerSubmission`. The
 * in-app dialog answers through `answerNext`; the composer only sees the
 * Promise, so the lock-holding behaviour is what this suite pins.
 */
function createConfirmQueue() {
  const pending: ((confirmed: boolean) => void)[] = [];
  return {
    confirmExitSession: () =>
      new Promise<boolean>(resolve => {
        pending.push(resolve);
      }),
    /** Answers the confirm the composer is waiting on. */
    answerNext(confirmed: boolean) {
      const resolve = pending.shift();
      if (!resolve) {
        throw new Error('No exit confirmation is waiting');
      }
      resolve(confirmed);
    },
    waiting: () => pending.length,
  };
}

function createSubmitLockAdapter(lock: SubmitLock): { current: boolean } {
  return {
    get current() {
      return lock.isLocked();
    },
    set current(next: boolean) {
      if (next) {
        lock.acquire();
      } else {
        lock.release();
      }
    },
  };
}

function createExitSubmissionHarness(confirmExitSession: () => Promise<boolean>) {
  const lock = createSubmitLock();
  const lockAdapter = createSubmitLockAdapter(lock);
  const order: string[] = [];
  const onExitSession = vi.fn(async (onAccepted: () => void) => {
    order.push('exit');
    await Promise.resolve();
    order.push('accepted');
    onAccepted();
  });
  const clearDraft = vi.fn(() => {
    order.push('clear');
  });
  const dismiss = vi.fn(() => {
    order.push('dismiss');
  });

  return {
    lock,
    order,
    onExitSession,
    clearDraft,
    dismiss,
    submit: async () => {
      const submitted = await settleVoiceInputBeforeSubmit({
        lock: lockAdapter,
        settleVoiceInput: async () => {
          await Promise.resolve();
          return true;
        },
        submit: async () => {
          await executeChatComposerSubmission(
            { type: 'exit-session' },
            {
              confirmExitSession,
              onExitSession,
              onSendCommand: vi.fn(),
              onCreateSession: vi.fn(),
              onRestartSession: vi.fn(),
              onSendPrompt: vi.fn(),
            },
            { clearDraft, dismiss }
          );
        },
      });
      return submitted;
    },
  };
}

describe('remote session exit submit lock integration', () => {
  it('holds the lock until the exit is cancelled and allows a later submission', async () => {
    const confirm = createConfirmQueue();
    const harness = createExitSubmissionHarness(confirm.confirmExitSession);
    const first = harness.submit();
    let firstSettled = false;
    async function observeFirstSettlement() {
      await first;
      firstSettled = true;
    }
    void observeFirstSettlement();

    await vi.waitFor(() => {
      expect(confirm.waiting()).toBe(1);
    });
    await Promise.resolve();

    expect(firstSettled).toBe(false);
    expect(harness.lock.isLocked()).toBe(true);
    await expect(harness.submit()).resolves.toBe(false);
    // The held confirmation is the only one waiting: a blocked second submit
    // never asks again.
    expect(confirm.waiting()).toBe(1);

    confirm.answerNext(false);
    await expect(first).resolves.toBe(true);

    expect(harness.onExitSession).not.toHaveBeenCalled();
    expect(harness.clearDraft).not.toHaveBeenCalled();
    expect(harness.dismiss).not.toHaveBeenCalled();
    expect(harness.lock.isLocked()).toBe(false);

    const afterCancel = harness.submit();
    await vi.waitFor(() => {
      expect(confirm.waiting()).toBe(1);
    });
    confirm.answerNext(false);
    await expect(afterCancel).resolves.toBe(true);

    expect(harness.onExitSession).not.toHaveBeenCalled();
    expect(harness.clearDraft).not.toHaveBeenCalled();
    expect(harness.dismiss).not.toHaveBeenCalled();
    expect(harness.lock.isLocked()).toBe(false);
  });

  it('executes once after the exit is confirmed and releases the lock', async () => {
    const confirm = createConfirmQueue();
    const harness = createExitSubmissionHarness(confirm.confirmExitSession);
    const first = harness.submit();

    await vi.waitFor(() => {
      expect(confirm.waiting()).toBe(1);
    });
    await expect(harness.submit()).resolves.toBe(false);
    expect(confirm.waiting()).toBe(1);

    confirm.answerNext(true);
    await expect(first).resolves.toBe(true);

    expect(harness.onExitSession).toHaveBeenCalledTimes(1);
    expect(harness.order).toEqual(['exit', 'accepted', 'clear', 'dismiss']);
    expect(harness.lock.isLocked()).toBe(false);
  });
});
