/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (node env, no jsdom); its React 19 deprecation notice points to the DOM-based Testing Library, which cannot render this app's non-DOM tree. See src/test/render-with-providers.tsx. */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useSettingsBackGuard } from './use-settings-back-guard';

const alertMock = vi.hoisted(() => vi.fn());
const dispatchMock = vi.hoisted(() => vi.fn());
const goBackMock = vi.hoisted(() => vi.fn());

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

vi.mock('react-native', () => ({
  Alert: { alert: alertMock },
}));

vi.mock('expo-router', () => ({
  useNavigation: () => ({ dispatch: dispatchMock, goBack: goBackMock }),
  useRouter: () => ({}),
}));

vi.mock('@/lib/navigation/prevent-remove', () => ({
  usePreventRemove: usePreventRemoveMock,
}));

type AlertButton = { text: string; style?: string; onPress?: () => void };

type GuardResult = ReturnType<typeof useSettingsBackGuard>;

let latest: GuardResult | undefined = undefined;

function GuardHarness({
  dirty,
  valid,
  onSave,
}: {
  dirty: boolean;
  valid: boolean;
  onSave: () => Promise<void>;
}) {
  latest = useSettingsBackGuard({ dirty, valid, onSave });
  return null;
}

async function noOpSave(): Promise<void> {
  await Promise.resolve();
}

function mountGuard(dirty: boolean, valid: boolean, onSave: () => Promise<void>) {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(createElement(GuardHarness, { dirty, valid, onSave }));
  });
  if (!ref.current || !latest) {
    throw new Error('guard did not render');
  }
  return { renderer: ref.current, result: latest };
}

function triggerPreventRemove(): Action {
  const action = { type: 'GO_BACK' };
  usePreventRemoveHolder.callback?.({ data: { action } });
  return action;
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

describe('useSettingsBackGuard', () => {
  beforeEach(() => {
    alertMock.mockReset();
    dispatchMock.mockReset();
    goBackMock.mockReset();
    usePreventRemoveMock.mockReset();
    usePreventRemoveHolder.preventRemove = undefined;
    usePreventRemoveHolder.callback = undefined;
    latest = undefined;
  });

  it('passes `dirty` alone as the preventRemove boolean', () => {
    const clean = mountGuard(false, true, noOpSave);
    expect(usePreventRemoveMock).toHaveBeenCalledTimes(1);
    expect(usePreventRemoveMock.mock.calls[0]?.[0]).toBe(false);
    act(() => {
      clean.renderer.unmount();
    });

    const dirty = mountGuard(true, true, noOpSave);
    expect(usePreventRemoveMock).toHaveBeenCalledTimes(2);
    expect(usePreventRemoveMock.mock.calls[1]?.[0]).toBe(true);
    act(() => {
      dirty.renderer.unmount();
    });
  });

  it('skips the confirm when the skip ref is armed and replays the action', () => {
    const { renderer, result } = mountGuard(true, true, noOpSave);
    result.skipNextGuardRef.current = true;

    const action = triggerPreventRemove();
    // The removal was already prevented, so the guard replays the action.
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(dispatchMock).toHaveBeenCalledWith(action);
    expect(alertMock).not.toHaveBeenCalled();
    // The bypass is one-shot: consumed on the removal it armed.
    expect(result.skipNextGuardRef.current).toBe(false);

    act(() => {
      renderer.unmount();
    });
  });

  it('shows Save / Discard / Keep Editing for a dirty-valid screen', () => {
    const { renderer } = mountGuard(true, true, noOpSave);

    triggerPreventRemove();
    expect(alertMock).toHaveBeenCalledTimes(1);
    expect(alertMock.mock.calls[0]?.[0]).toBe('Unsaved changes');
    expect(lastAlertButtons()?.map(button => button.text)).toEqual([
      'Save changes',
      'Discard',
      'Keep Editing',
    ]);

    act(() => {
      renderer.unmount();
    });
  });

  it('shows Discard / Keep Editing for a dirty-invalid screen', () => {
    const { renderer } = mountGuard(true, false, noOpSave);

    triggerPreventRemove();
    expect(alertMock).toHaveBeenCalledTimes(1);
    expect(lastAlertButtons()?.map(button => button.text)).toEqual(['Discard', 'Keep Editing']);

    act(() => {
      renderer.unmount();
    });
  });

  it('Save runs onSave before dispatching the captured action', async () => {
    const order: string[] = [];
    dispatchMock.mockImplementation(() => {
      order.push('dispatch');
    });
    const onSave = vi.fn(async () => {
      await Promise.resolve();
      order.push('save');
    });
    const { renderer } = mountGuard(true, true, onSave);
    triggerPreventRemove();

    const save = lastAlertButtons()?.find(button => button.text === 'Save changes');
    expect(save?.onPress).toBeDefined();

    act(() => {
      save?.onPress?.();
    });
    await flushMicrotasks();

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    // onSave must run before navigation (dispatch).
    expect(order).toEqual(['save', 'dispatch']);

    act(() => {
      renderer.unmount();
    });
  });

  it('stays on the screen when the save fails', async () => {
    const onSave = vi.fn(async () => {
      await Promise.reject(new Error('save failure'));
    });
    const { renderer } = mountGuard(true, true, onSave);
    triggerPreventRemove();

    const save = lastAlertButtons()?.find(button => button.text === 'Save changes');
    expect(save?.onPress).toBeDefined();

    act(() => {
      save?.onPress?.();
    });
    await flushMicrotasks();

    expect(onSave).toHaveBeenCalledTimes(1);
    // The failed save must not navigate: the screen stays for a retry or discard.
    expect(dispatchMock).not.toHaveBeenCalled();

    act(() => {
      renderer.unmount();
    });
  });

  it('Discard dispatches the captured action', () => {
    const { renderer } = mountGuard(true, true, noOpSave);
    triggerPreventRemove();

    const discard = lastAlertButtons()?.find(button => button.text === 'Discard');
    expect(discard?.onPress).toBeDefined();

    act(() => {
      discard?.onPress?.();
    });
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(dispatchMock).toHaveBeenCalledWith({ type: 'GO_BACK' });

    act(() => {
      renderer.unmount();
    });
  });

  it('Keep Editing leaves the screen untouched', () => {
    const onSave = vi.fn(async () => {
      await Promise.resolve();
    });
    const { renderer } = mountGuard(true, true, onSave);
    triggerPreventRemove();

    const keep = lastAlertButtons()?.find(button => button.text === 'Keep Editing');
    // The cancel button carries no handler: dismissing it must not save or leave.
    expect(keep?.onPress).toBeUndefined();
    expect(onSave).not.toHaveBeenCalled();
    expect(dispatchMock).not.toHaveBeenCalled();

    act(() => {
      renderer.unmount();
    });
  });
});
