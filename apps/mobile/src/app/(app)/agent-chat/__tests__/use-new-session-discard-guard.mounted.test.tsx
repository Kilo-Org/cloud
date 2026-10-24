import { act } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  alertMock,
  backMock,
  classNameOf,
  dismissDialogSheet,
  dispatchMock,
  flushMicrotasks,
  isType,
  mountGuard,
  mountGuardWithAttachments,
  mountGuardWithPicker,
  noOpDiscard,
  platform,
  PLATFORMS,
  pressDialogButton,
  renderedLabels,
  resetGuardHarness,
  toastErrorMock,
  triggerPreventRemoveInAct,
  usePreventRemoveHolder,
  usePreventRemoveMock,
} from './use-new-session-discard-guard-test-helpers';

describe('useNewSessionDiscardGuard', () => {
  beforeEach(() => {
    resetGuardHarness();
  });

  it.each(PLATFORMS)('guards the leave while the prompt is non-empty (%s)', os => {
    platform.os = os;
    const { renderer } = mountGuard(true, noOpDiscard);

    expect(usePreventRemoveMock).toHaveBeenCalledTimes(1);
    expect(usePreventRemoveMock.mock.calls[0]?.[0]).toBe(true);

    act(() => {
      renderer.unmount();
    });
  });

  // The requested behaviour: one implementation for both platforms. Neither
  // platform falls back to the native `Alert.alert`; both open the in-app
  // destructive confirm, which paints the discard choice with the red fill.
  it.each(PLATFORMS)('opens the in-app destructive confirm on %s', os => {
    platform.os = os;
    const { renderer } = mountGuard(true, noOpDiscard);

    triggerPreventRemoveInAct();

    expect(alertMock).not.toHaveBeenCalled();
    expect(renderedLabels(renderer)).toEqual(
      expect.arrayContaining(['Discard draft?', 'Discard', 'Keep editing'])
    );
    // The destructive choice carries the red fill, the safe one a neutral outline.
    expect(
      renderer.root.findAll(
        node => isType(node, 'Pressable') && classNameOf(node).includes('bg-destructive')
      )
    ).toHaveLength(1);

    act(() => {
      renderer.unmount();
    });
  });

  it.each(PLATFORMS)('shows the upload-specific confirm for an attachment-only state (%s)', os => {
    platform.os = os;
    const { renderer } = mountGuardWithAttachments();

    // An unsent upload makes the screen dirty even with an empty prompt, so
    // the leave is still intercepted.
    expect(usePreventRemoveMock).toHaveBeenCalledTimes(1);
    expect(usePreventRemoveMock.mock.calls[0]?.[0]).toBe(true);

    triggerPreventRemoveInAct();

    expect(alertMock).not.toHaveBeenCalled();
    // The copy names the unclaimed uploads instead of the prompt-only message.
    expect(renderedLabels(renderer)).toContain(
      'Your prompt and any unclaimed uploads will be deleted.'
    );

    act(() => {
      renderer.unmount();
    });
  });

  it('leaves without a confirm when the prompt is empty', () => {
    const { renderer } = mountGuard(false, noOpDiscard);

    // The removal is held for every prompt state: a Back that lands while a
    // picker is presenting arrives before this screen re-rendered, so the guard
    // reads the live stack when the removal happens instead of at render.
    expect(usePreventRemoveMock.mock.calls[0]?.[0]).toBe(true);

    const action = triggerPreventRemoveInAct();

    // No picker above and nothing to lose: the leave is replayed unchanged.
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(dispatchMock).toHaveBeenCalledWith(action);
    expect(alertMock).not.toHaveBeenCalled();
    expect(renderedLabels(renderer)).not.toContain('Discard draft?');

    act(() => {
      renderer.unmount();
    });
  });

  it('skips the confirm when the skip ref is armed (successful Start)', () => {
    const { renderer, skipRef } = mountGuard(true, noOpDiscard);
    skipRef.current = true;

    expect(usePreventRemoveMock).toHaveBeenCalledTimes(1);
    expect(usePreventRemoveMock.mock.calls[0]?.[0]).toBe(true);

    const action = triggerPreventRemoveInAct();
    // The removal was already prevented, so the guard replays the action.
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(dispatchMock).toHaveBeenCalledWith(action);
    expect(alertMock).not.toHaveBeenCalled();
    expect(renderedLabels(renderer)).not.toContain('Discard draft?');
    // The bypass is one-shot: consumed on the removal it armed.
    expect(skipRef.current).toBe(false);
    expect(usePreventRemoveHolder.preventRemove).toBe(false);

    act(() => {
      renderer.unmount();
    });
  });

  it.each(['PUSH', 'NAVIGATE', 'JUMP_TO'])(
    'replays a forward %s removal unconfirmed — the durable draft survives it',
    actionType => {
      const { renderer } = mountGuard(true, noOpDiscard);

      // Tapping another screen (e.g. Preferences from the tab bar) can remove
      // this screen as a side effect; that is forward navigation, not an
      // abandon, so the discard confirm must not hijack it (spot check
      // e12-tap-prefs: the dialog blocked the Preferences screen from opening).
      const action = { type: actionType };
      act(() => {
        usePreventRemoveHolder.callback?.({
          data: { action },
          repeat: () => {
            dispatchMock(action);
          },
        });
      });

      expect(alertMock).not.toHaveBeenCalled();
      expect(renderedLabels(renderer)).not.toContain('Discard draft?');
      expect(dispatchMock).toHaveBeenCalledTimes(1);
      expect(dispatchMock).toHaveBeenCalledWith(action);
      expect(usePreventRemoveHolder.preventRemove).toBe(false);

      act(() => {
        renderer.unmount();
      });
    }
  );

  it.each(PLATFORMS)(
    'runs onDiscard before dispatching when Discard is accepted (%s)',
    async os => {
      platform.os = os;
      const order: string[] = [];
      dispatchMock.mockImplementation(() => {
        order.push('dispatch');
      });
      const onDiscard = vi.fn(async () => {
        await Promise.resolve();
        order.push('discard');
      });
      const { renderer } = mountGuard(true, onDiscard);

      const action = triggerPreventRemoveInAct();
      pressDialogButton(renderer, 'bg-destructive');

      // The choice is made, but the request stays on screen through the native
      // dismissal and nothing is cleared or replayed yet.
      expect(renderedLabels(renderer)).toContain('Discard draft?');
      expect(onDiscard).not.toHaveBeenCalled();
      expect(dispatchMock).not.toHaveBeenCalled();

      dismissDialogSheet(renderer);

      // The completed dismissal ends the confirm; the clear runs behind it.
      expect(renderedLabels(renderer)).not.toContain('Discard draft?');

      await flushMicrotasks();

      expect(onDiscard).toHaveBeenCalledTimes(1);
      expect(dispatchMock).toHaveBeenCalledTimes(1);
      expect(dispatchMock).toHaveBeenCalledWith(action);
      // The draft clear must finish before the captured leave is replayed.
      expect(order).toEqual(['discard', 'dispatch']);
      expect(usePreventRemoveHolder.preventRemove).toBe(false);

      act(() => {
        renderer.unmount();
      });
    }
  );

  it.each(PLATFORMS)(
    'closes the confirm, stays, and toasts when the clear fails (%s)',
    async os => {
      platform.os = os;
      const onDiscard = vi.fn(async () => {
        await Promise.reject(new Error('storage failure'));
      });
      const { renderer } = mountGuard(true, onDiscard);

      triggerPreventRemoveInAct();
      expect(renderedLabels(renderer)).toContain('Discard draft?');

      pressDialogButton(renderer, 'bg-destructive');
      // The clear starts only once the native dismissal reports.
      expect(onDiscard).not.toHaveBeenCalled();

      dismissDialogSheet(renderer);
      await flushMicrotasks();

      expect(onDiscard).toHaveBeenCalledTimes(1);
      expect(dispatchMock).not.toHaveBeenCalled();
      expect(toastErrorMock).toHaveBeenCalledWith('Could not discard the draft. Please try again.');
      expect(usePreventRemoveHolder.preventRemove).toBe(true);
      // Closed, so the user can retry by leaving again with the draft intact.
      expect(renderedLabels(renderer)).not.toContain('Discard draft?');

      act(() => {
        renderer.unmount();
      });
    }
  );

  it('keeps a Back that lands while a picker is presenting with that picker', () => {
    // Clean prompt: the picker rule is the only reason the removal is held.
    const { renderer } = mountGuardWithPicker();

    expect(usePreventRemoveMock.mock.calls[0]?.[0]).toBe(true);

    const action = { type: 'GO_BACK' };
    act(() => {
      usePreventRemoveHolder.callback?.({
        data: { action },
        repeat: () => {
          dispatchMock(action);
        },
      });
    });

    // The picker route is the top of the stack, so closing it is the removal
    // the Back asked for; the composer is never replayed away.
    expect(backMock).toHaveBeenCalledTimes(1);
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(alertMock).not.toHaveBeenCalled();
    expect(renderedLabels(renderer)).not.toContain('Discard draft?');

    act(() => {
      renderer.unmount();
    });
  });

  it('replays a forward removal that happens while a picker is above', () => {
    const { renderer } = mountGuardWithPicker();

    const action = { type: 'RESET' };
    act(() => {
      usePreventRemoveHolder.callback?.({
        data: { action },
        repeat: () => {
          dispatchMock(action);
        },
      });
    });

    expect(backMock).not.toHaveBeenCalled();
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(dispatchMock).toHaveBeenCalledWith(action);

    act(() => {
      renderer.unmount();
    });
  });

  it.each(PLATFORMS)('keeps the draft and stays when the confirm is dismissed (%s)', os => {
    platform.os = os;
    const onDiscard = vi.fn(async () => {
      await Promise.resolve();
    });
    const { renderer } = mountGuard(true, onDiscard);

    triggerPreventRemoveInAct();
    pressDialogButton(renderer, 'border-border');

    // Keep editing: the request stays on screen until the native dismissal
    // reports, and the draft is never cleared.
    expect(renderedLabels(renderer)).toContain('Discard draft?');

    dismissDialogSheet(renderer);

    expect(onDiscard).not.toHaveBeenCalled();
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(renderedLabels(renderer)).not.toContain('Discard draft?');
    expect(usePreventRemoveHolder.preventRemove).toBe(true);

    act(() => {
      renderer.unmount();
    });
  });
});
