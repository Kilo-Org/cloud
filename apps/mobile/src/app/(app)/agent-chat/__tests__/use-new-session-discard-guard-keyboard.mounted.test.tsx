import { act } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  dismissDialogSheet,
  dispatchMock,
  flushMicrotasks,
  focusedInput,
  focusTextInputMock,
  keyboardDismissMock,
  mountGuard,
  noOpDiscard,
  platform,
  PLATFORMS,
  pressDialogButton,
  renderedLabels,
  resetGuardHarness,
  setKeyboardVisible,
  setWindowFocused,
  triggerPreventRemoveInAct,
} from './use-new-session-discard-guard-test-helpers';

describe('useNewSessionDiscardGuard with the keyboard open', () => {
  beforeEach(() => {
    resetGuardHarness();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(PLATFORMS)('presents the confirm only after the keyboard has closed (%s)', os => {
    platform.os = os;
    focusedInput.current = {};
    setKeyboardVisible(true);
    const { renderer } = mountGuard(true, noOpDiscard);

    triggerPreventRemoveInAct();

    expect(keyboardDismissMock).toHaveBeenCalledTimes(1);
    expect(renderedLabels(renderer)).not.toContain('Discard draft?');

    setKeyboardVisible(false);

    expect(renderedLabels(renderer)).toContain('Discard draft?');

    act(() => {
      renderer.unmount();
    });
  });

  it('opens on another Back when the keyboard-hide event is missing', async () => {
    focusedInput.current = {};
    setKeyboardVisible(true);
    const { renderer } = mountGuard(true, noOpDiscard);

    triggerPreventRemoveInAct();
    expect(renderedLabels(renderer)).not.toContain('Discard draft?');

    triggerPreventRemoveInAct();
    expect(renderedLabels(renderer)).toContain('Discard draft?');
    pressDialogButton(renderer, 'bg-destructive');
    dismissDialogSheet(renderer);
    await flushMicrotasks();

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    act(() => {
      renderer.unmount();
    });
  });

  it('bounds the wait when the keyboard-hide event never arrives', () => {
    vi.useFakeTimers();
    focusedInput.current = {};
    setKeyboardVisible(true);
    const { renderer } = mountGuard(true, noOpDiscard);

    triggerPreventRemoveInAct();
    act(() => vi.advanceTimersByTime(999));
    expect(renderedLabels(renderer)).not.toContain('Discard draft?');

    act(() => vi.advanceTimersByTime(1));
    expect(renderedLabels(renderer)).toContain('Discard draft?');
    pressDialogButton(renderer, 'border-border');
    dismissDialogSheet(renderer);

    act(() => vi.runAllTimers());
    expect(renderedLabels(renderer)).not.toContain('Discard draft?');
    expect(dispatchMock).not.toHaveBeenCalled();
    act(() => {
      renderer.unmount();
    });
  });

  it('refocuses the prompt only after Keep editing finishes dismissing (ios)', () => {
    const prompt = {};
    focusedInput.current = prompt;
    setKeyboardVisible(true);
    const { renderer } = mountGuard(true, noOpDiscard);

    triggerPreventRemoveInAct();
    setKeyboardVisible(false);
    pressDialogButton(renderer, 'border-border');

    expect(focusTextInputMock).not.toHaveBeenCalled();

    dismissDialogSheet(renderer);

    expect(focusTextInputMock).toHaveBeenCalledTimes(1);
    expect(focusTextInputMock).toHaveBeenCalledWith(prompt);

    act(() => {
      renderer.unmount();
    });
  });

  it('refocuses the prompt on Android once the app window has focus again', () => {
    platform.os = 'android';
    const prompt = {};
    focusedInput.current = prompt;
    setKeyboardVisible(true);
    const { renderer } = mountGuard(true, noOpDiscard);

    triggerPreventRemoveInAct();
    setKeyboardVisible(false);
    // The presented sheet's dialog window takes focus from the app window.
    setWindowFocused(false);
    pressDialogButton(renderer, 'border-border');
    dismissDialogSheet(renderer);

    // The dismissal reports before the app window is focused, where Android
    // drops a keyboard request.
    expect(focusTextInputMock).not.toHaveBeenCalled();

    setWindowFocused(true);

    expect(focusTextInputMock).toHaveBeenCalledTimes(1);
    expect(focusTextInputMock).toHaveBeenCalledWith(prompt);

    act(() => {
      renderer.unmount();
    });
  });

  it.each(PLATFORMS)('leaves the keyboard down when Discard is chosen (%s)', async os => {
    platform.os = os;
    focusedInput.current = {};
    setKeyboardVisible(true);
    const { renderer } = mountGuard(true, noOpDiscard);

    triggerPreventRemoveInAct();
    setKeyboardVisible(false);
    pressDialogButton(renderer, 'bg-destructive');
    dismissDialogSheet(renderer);
    await flushMicrotasks();

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(focusTextInputMock).not.toHaveBeenCalled();

    act(() => {
      renderer.unmount();
    });
  });
});
