import { createElement, Fragment, type RefObject } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useNewSessionDiscardGuard } from '@/components/agents/use-new-session-discard-guard';

const alertMock = vi.hoisted(() => vi.fn());
const dispatchMock = vi.hoisted(() => vi.fn());
const toastErrorMock = vi.hoisted(() => vi.fn());
// Mutable so a single file proves the confirm is one cross-platform
// implementation: the same in-app dialog opens for both platform values, and
// the native alert is never reached on either.
const platform = vi.hoisted(() => ({ os: 'ios' as 'ios' | 'android' }));

/** Both platform values, so every behaviour below is proven for iOS and Android. */
const PLATFORMS = ['ios', 'android'] as const;

type Action = { type: string };

const usePreventRemoveHolder = vi.hoisted(() => ({
  preventRemove: undefined as boolean | undefined,
  callback: undefined as ((options: { data: { action: Action } }) => void) | undefined,
}));

const usePreventRemoveMock = vi.hoisted(() =>
  vi.fn((preventRemove: boolean, handler: (options: { data: { action: Action } }) => void) => {
    usePreventRemoveHolder.preventRemove = preventRemove;
    usePreventRemoveHolder.callback = handler;
  })
);

// The dialog the hook returns is rendered for real, so its primitives and the
// UI components it composes are stubbed the same way the dialog's own mounted
// test stubs them. `Alert` stays mocked only so a regression that reaches for
// the native confirm again fails here.
vi.mock('react-native', () => ({
  Alert: { alert: alertMock },
  I18nManager: { isRTL: false },
  Modal: 'Modal',
  Platform: {
    get OS() {
      return platform.os;
    },
  },
  Pressable: 'Pressable',
  Text: 'Text',
  View: 'View',
}));

vi.mock('@rn-primitives/slot', () => ({ Text: 'Slot.Text' }));

vi.mock('@/components/ui/activity-indicator', () => ({
  ActivityIndicator: 'ActivityIndicator',
}));

vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    destructiveForeground: '#FFFFFF',
    foreground: '#1A1A10',
    primary: '#00BAA9',
    primaryForeground: '#FFFFFF',
  }),
}));

vi.mock('sonner-native', () => ({
  toast: { error: toastErrorMock },
}));

vi.mock('expo-router', () => ({
  useNavigation: () => ({ dispatch: dispatchMock }),
}));

vi.mock('@/lib/navigation/prevent-remove', () => ({
  usePreventRemove: usePreventRemoveMock,
}));

function GuardHarness({
  dirty,
  hasUnclaimedAttachments = false,
  onDiscard,
  skipRef,
}: {
  dirty: boolean;
  hasUnclaimedAttachments?: boolean;
  onDiscard: () => Promise<void>;
  skipRef: RefObject<boolean>;
}) {
  const { discardConfirm } = useNewSessionDiscardGuard({
    dirty,
    hasUnclaimedAttachments,
    onDiscard,
    skipNextGuardRef: skipRef,
  });
  // The screen body renders `discardConfirm` once in its tree; the harness does
  // the same so the returned node is exercised, not just its props.
  return createElement(Fragment, null, discardConfirm);
}

async function noOpDiscard(): Promise<void> {
  await Promise.resolve();
}

function mountGuard(dirty: boolean, onDiscard: () => Promise<void>) {
  const skipRef: RefObject<boolean> = { current: false };
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(createElement(GuardHarness, { dirty, onDiscard, skipRef }));
  });
  if (!ref.current) {
    throw new Error('guard did not render');
  }
  return { renderer: ref.current, skipRef };
}

function mountGuardWithAttachments() {
  const skipRef: RefObject<boolean> = { current: false };
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(
      createElement(GuardHarness, {
        dirty: true,
        hasUnclaimedAttachments: true,
        onDiscard: noOpDiscard,
        skipRef,
      })
    );
  });
  if (!ref.current) {
    throw new Error('guard did not render');
  }
  return { renderer: ref.current };
}

function triggerPreventRemove(): Action {
  const action = { type: 'GO_BACK' };
  usePreventRemoveHolder.callback?.({ data: { action } });
  return action;
}

/** Triggers a leave inside `act` so the confirm's state update flushes. */
function triggerPreventRemoveInAct(): Action {
  const holder: { action: Action } = { action: { type: 'GO_BACK' } };
  act(() => {
    holder.action = triggerPreventRemove();
  });
  return holder.action;
}

function isType(node: TestRenderer.ReactTestInstance, type: string): boolean {
  return typeof node.type === 'string' && node.type === type;
}

function classNameOf(node: TestRenderer.ReactTestInstance): string {
  return typeof node.props.className === 'string' ? node.props.className : '';
}

/** Every string rendered through a `Text` node, in tree order. */
function renderedLabels(renderer: TestRenderer.ReactTestRenderer): string[] {
  return renderer.root
    .findAll(node => isType(node, 'Text'))
    .flatMap(node => node.children.filter((child): child is string => typeof child === 'string'));
}

/**
 * Presses the dialog control whose button variant carries `token` (the
 * destructive fill or the neutral outline), by the same class-based lookup the
 * dialog's own mounted test uses.
 */
function pressDialogButton(renderer: TestRenderer.ReactTestRenderer, token: string) {
  const node = renderer.root.find(
    candidate => isType(candidate, 'Pressable') && classNameOf(candidate).includes(token)
  );
  act(() => {
    (node.props as { onPress?: () => void }).onPress?.();
  });
}

async function flushMicrotasks() {
  await act(async () => {
    await new Promise(resolve => {
      setTimeout(resolve, 0);
    });
  });
}

describe('useNewSessionDiscardGuard', () => {
  beforeEach(() => {
    platform.os = 'ios';
    alertMock.mockReset();
    dispatchMock.mockReset();
    toastErrorMock.mockReset();
    usePreventRemoveMock.mockReset();
    usePreventRemoveHolder.preventRemove = undefined;
    usePreventRemoveHolder.callback = undefined;
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

  it('leaves with no confirm when the prompt is empty', () => {
    const { renderer } = mountGuard(false, noOpDiscard);

    expect(usePreventRemoveMock).toHaveBeenCalledTimes(1);
    expect(usePreventRemoveMock.mock.calls[0]?.[0]).toBe(false);

    // The hook never invokes the callback when the boolean is false, so the
    // guard delegates the decision to the hook and nothing else fires.
    expect(alertMock).not.toHaveBeenCalled();
    expect(dispatchMock).not.toHaveBeenCalled();
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

    const action = triggerPreventRemove();
    // The removal was already prevented, so the guard replays the action.
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(dispatchMock).toHaveBeenCalledWith(action);
    expect(alertMock).not.toHaveBeenCalled();
    expect(renderedLabels(renderer)).not.toContain('Discard draft?');
    // The bypass is one-shot: consumed on the removal it armed.
    expect(skipRef.current).toBe(false);

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
      usePreventRemoveHolder.callback?.({ data: { action } });

      expect(alertMock).not.toHaveBeenCalled();
      expect(renderedLabels(renderer)).not.toContain('Discard draft?');
      expect(dispatchMock).toHaveBeenCalledTimes(1);
      expect(dispatchMock).toHaveBeenCalledWith(action);

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

      // Accepting closes the confirm right away; the clear runs behind it.
      expect(renderedLabels(renderer)).not.toContain('Discard draft?');

      await flushMicrotasks();

      expect(onDiscard).toHaveBeenCalledTimes(1);
      expect(dispatchMock).toHaveBeenCalledTimes(1);
      expect(dispatchMock).toHaveBeenCalledWith(action);
      // The draft clear must finish before the captured leave is replayed.
      expect(order).toEqual(['discard', 'dispatch']);

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
      await flushMicrotasks();

      expect(onDiscard).toHaveBeenCalledTimes(1);
      expect(dispatchMock).not.toHaveBeenCalled();
      expect(toastErrorMock).toHaveBeenCalledWith('Could not discard the draft. Please try again.');
      // Closed, so the user can retry by leaving again with the draft intact.
      expect(renderedLabels(renderer)).not.toContain('Discard draft?');

      act(() => {
        renderer.unmount();
      });
    }
  );

  it.each(PLATFORMS)('keeps the draft and stays when the confirm is dismissed (%s)', os => {
    platform.os = os;
    const onDiscard = vi.fn(async () => {
      await Promise.resolve();
    });
    const { renderer } = mountGuard(true, onDiscard);

    triggerPreventRemoveInAct();
    pressDialogButton(renderer, 'border-border');

    expect(onDiscard).not.toHaveBeenCalled();
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(renderedLabels(renderer)).not.toContain('Discard draft?');

    act(() => {
      renderer.unmount();
    });
  });
});
