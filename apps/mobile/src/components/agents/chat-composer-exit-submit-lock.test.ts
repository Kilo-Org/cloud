import { type AlertButton, type AlertOptions } from 'react-native';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { showRemoteSessionExitConfirmation } from '@/components/agents/remote-session-exit-alert';
import { executeChatComposerSubmission } from '@/components/agents/chat-composer-submission';
import { createSubmitLock, type SubmitLock } from '@/lib/submit-lock';
import { settleVoiceInputBeforeSubmit } from '@/lib/voice-input/voice-input-submit';

type AlertCall = [title: string, message: string, buttons: AlertButton[], options?: AlertOptions];

const reactNativeMock = vi.hoisted(() => ({
  alert: vi.fn<(...args: AlertCall) => void>(),
}));

vi.mock('react-native', () => ({ Alert: { alert: reactNativeMock.alert } }));

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

function createExitSubmissionHarness() {
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
  const resetAttachments = vi.fn((): void => undefined);

  return {
    lock,
    order,
    onExitSession,
    clearDraft,
    dismiss,
    resetAttachments,
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
              confirmExitSession: showRemoteSessionExitConfirmation,
              onExitSession,
              onSendCommand: vi.fn(),
              onCreateSession: vi.fn(),
              onSendPrompt: vi.fn(),
            },
            { clearDraft, dismiss, resetAttachments }
          );
        },
      });
      return submitted;
    },
  };
}

function getAlertCall(index: number): AlertCall {
  const call = reactNativeMock.alert.mock.calls[index];
  if (!call) {
    throw new Error(`Expected Alert.alert call ${index + 1}`);
  }
  return call;
}

describe('remote session exit submit lock integration', () => {
  beforeEach(() => {
    reactNativeMock.alert.mockReset();
  });

  it('holds the lock until native cancellation and allows a later submission', async () => {
    const harness = createExitSubmissionHarness();
    const first = harness.submit();
    let firstSettled = false;
    async function observeFirstSettlement() {
      await first;
      firstSettled = true;
    }
    void observeFirstSettlement();

    await vi.waitFor(() => {
      expect(reactNativeMock.alert).toHaveBeenCalledTimes(1);
    });
    await Promise.resolve();

    expect(firstSettled).toBe(false);
    expect(harness.lock.isLocked()).toBe(true);
    await expect(harness.submit()).resolves.toBe(false);
    expect(reactNativeMock.alert).toHaveBeenCalledTimes(1);

    getAlertCall(0)[2][0]?.onPress?.();
    await expect(first).resolves.toBe(true);

    expect(harness.onExitSession).not.toHaveBeenCalled();
    expect(harness.clearDraft).not.toHaveBeenCalled();
    expect(harness.dismiss).not.toHaveBeenCalled();
    expect(harness.lock.isLocked()).toBe(false);

    const afterCancel = harness.submit();
    await vi.waitFor(() => {
      expect(reactNativeMock.alert).toHaveBeenCalledTimes(2);
    });
    getAlertCall(1)[3]?.onDismiss?.();
    await expect(afterCancel).resolves.toBe(true);

    expect(harness.onExitSession).not.toHaveBeenCalled();
    expect(harness.clearDraft).not.toHaveBeenCalled();
    expect(harness.dismiss).not.toHaveBeenCalled();
    expect(harness.lock.isLocked()).toBe(false);
  });

  it('executes once after destructive confirmation and releases the lock', async () => {
    const harness = createExitSubmissionHarness();
    const first = harness.submit();

    await vi.waitFor(() => {
      expect(reactNativeMock.alert).toHaveBeenCalledTimes(1);
    });
    await expect(harness.submit()).resolves.toBe(false);
    expect(reactNativeMock.alert).toHaveBeenCalledTimes(1);

    getAlertCall(0)[2][1]?.onPress?.();
    await expect(first).resolves.toBe(true);

    expect(harness.onExitSession).toHaveBeenCalledTimes(1);
    expect(harness.order).toEqual(['exit', 'accepted', 'clear', 'dismiss']);
    expect(harness.resetAttachments).not.toHaveBeenCalled();
    expect(harness.lock.isLocked()).toBe(false);
  });
});
