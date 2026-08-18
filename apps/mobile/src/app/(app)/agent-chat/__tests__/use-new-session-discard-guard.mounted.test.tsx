/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (node env, no jsdom); its React 19 deprecation notice points to the DOM-based Testing Library, which cannot render this app's non-DOM tree. See src/test/render-with-providers.tsx. */
import { createElement, type RefObject } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useNewSessionDiscardGuard } from '../use-new-session-discard-guard';

const alertMock = vi.hoisted(() => vi.fn());
const dispatchMock = vi.hoisted(() => vi.fn());
const toastErrorMock = vi.hoisted(() => vi.fn());

const beforeRemoveHolder = vi.hoisted(() => ({
  handler: undefined as ((event: BeforeRemoveEvent) => void) | undefined,
}));

const addListenerMock = vi.hoisted(() =>
  vi.fn((event: string, handler: (e: BeforeRemoveEvent) => void) => {
    if (event === 'beforeRemove') {
      beforeRemoveHolder.handler = handler;
    }
    return () => undefined;
  })
);

vi.mock('react-native', () => ({
  Alert: { alert: alertMock },
}));

vi.mock('sonner-native', () => ({
  toast: { error: toastErrorMock },
}));

vi.mock('expo-router', () => ({
  useNavigation: () => ({ addListener: addListenerMock, dispatch: dispatchMock }),
}));

type BeforeRemoveEvent = {
  preventDefault: () => void;
  data: { action: { type: string } };
};

type AlertButton = { text: string; style?: string; onPress?: () => void };

function GuardHarness({
  dirty,
  onDiscard,
  skipRef,
}: {
  dirty: boolean;
  onDiscard: () => Promise<void>;
  skipRef: RefObject<boolean>;
}) {
  useNewSessionDiscardGuard({ dirty, onDiscard, skipNextGuardRef: skipRef });
  return null;
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

function triggerBeforeRemove(): { preventDefault: () => void; action: { type: string } } {
  const preventDefault = vi.fn<() => void>();
  const action = { type: 'GO_BACK' };
  beforeRemoveHolder.handler?.({ preventDefault, data: { action } });
  return { preventDefault, action };
}

function lastAlertButtons(): AlertButton[] | undefined {
  return alertMock.mock.calls.at(-1)?.[2] as AlertButton[] | undefined;
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
    alertMock.mockReset();
    dispatchMock.mockReset();
    toastErrorMock.mockReset();
    addListenerMock.mockReset();
    beforeRemoveHolder.handler = undefined;
  });

  it('shows the confirm when the prompt is non-empty', () => {
    const { renderer } = mountGuard(true, noOpDiscard);

    const { preventDefault } = triggerBeforeRemove();
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(alertMock).toHaveBeenCalledTimes(1);
    expect(alertMock.mock.calls[0]?.[0]).toBe('Discard draft?');
    expect(lastAlertButtons()?.map(button => button.text)).toEqual(['Keep editing', 'Discard']);

    act(() => {
      renderer.unmount();
    });
  });

  it('leaves with no alert when the prompt is empty', () => {
    const { renderer } = mountGuard(false, noOpDiscard);

    const { preventDefault } = triggerBeforeRemove();
    expect(preventDefault).not.toHaveBeenCalled();
    expect(alertMock).not.toHaveBeenCalled();
    expect(dispatchMock).not.toHaveBeenCalled();

    act(() => {
      renderer.unmount();
    });
  });

  it('skips the confirm when the skip ref is armed (successful Start)', () => {
    const { renderer, skipRef } = mountGuard(true, noOpDiscard);
    skipRef.current = true;

    const { preventDefault } = triggerBeforeRemove();
    expect(preventDefault).not.toHaveBeenCalled();
    expect(alertMock).not.toHaveBeenCalled();
    expect(dispatchMock).not.toHaveBeenCalled();
    // The bypass is one-shot: consumed on the removal it armed.
    expect(skipRef.current).toBe(false);

    act(() => {
      renderer.unmount();
    });
  });

  it('Discard runs onDiscard before dispatching the captured action', async () => {
    const order: string[] = [];
    dispatchMock.mockImplementation(() => {
      order.push('dispatch');
    });
    const onDiscard = vi.fn(async () => {
      await Promise.resolve();
      order.push('discard');
    });
    const { renderer } = mountGuard(true, onDiscard);
    triggerBeforeRemove();

    const discard = lastAlertButtons()?.find(button => button.text === 'Discard');
    expect(discard?.onPress).toBeDefined();

    act(() => {
      discard?.onPress?.();
    });
    await flushMicrotasks();

    expect(onDiscard).toHaveBeenCalledTimes(1);
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    // onDiscard (clear the draft) must run before navigation (dispatch).
    expect(order).toEqual(['discard', 'dispatch']);

    act(() => {
      renderer.unmount();
    });
  });

  it('stays and toasts when the draft clear fails', async () => {
    const onDiscard = vi.fn(async () => {
      await Promise.reject(new Error('storage failure'));
    });
    const { renderer } = mountGuard(true, onDiscard);
    triggerBeforeRemove();

    const discard = lastAlertButtons()?.find(button => button.text === 'Discard');
    expect(discard?.onPress).toBeDefined();

    act(() => {
      discard?.onPress?.();
    });
    await flushMicrotasks();

    expect(onDiscard).toHaveBeenCalledTimes(1);
    // The failed clear must not navigate: the screen stays and the draft is kept.
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(toastErrorMock).toHaveBeenCalledWith('Could not discard the draft. Please try again.');

    act(() => {
      renderer.unmount();
    });
  });

  it('Keep editing leaves the draft intact', () => {
    const onDiscard = vi.fn(async () => {
      await Promise.resolve();
    });
    const { renderer } = mountGuard(true, onDiscard);
    triggerBeforeRemove();

    const keep = lastAlertButtons()?.find(button => button.text === 'Keep editing');
    // The cancel button carries no handler: dismissing it must not clear or leave.
    expect(keep?.onPress).toBeUndefined();
    expect(onDiscard).not.toHaveBeenCalled();
    expect(dispatchMock).not.toHaveBeenCalled();

    act(() => {
      renderer.unmount();
    });
  });
});
