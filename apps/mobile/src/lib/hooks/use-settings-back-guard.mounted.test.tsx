import { createElement, isValidElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type ConfirmDialogProps } from '@/components/ui/dialog';

import { type SettingsBackGuardResult, useSettingsBackGuard } from './use-settings-back-guard';

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

// The guard builds its confirmation through the real `useConfirmDialog`, so the
// pieces that dialog imports are stubbed: this suite reads the request it hands
// to `confirm` (and its dismissal callback) without mounting the native dialog.
vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('@rn-primitives/alert-dialog', () => ({
  Action: 'AlertDialog.Action',
  Cancel: 'AlertDialog.Cancel',
  Content: 'AlertDialog.Content',
  Description: 'AlertDialog.Description',
  Overlay: 'AlertDialog.Overlay',
  Portal: 'AlertDialog.Portal',
  Root: 'AlertDialog.Root',
  Title: 'AlertDialog.Title',
}));
vi.mock('@/components/destructive-confirm-dialog', () => ({
  DestructiveConfirmDialog: 'DestructiveConfirmDialog',
}));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));

vi.mock('expo-router', () => ({
  useNavigation: () => ({ dispatch: dispatchMock, goBack: goBackMock }),
  useRouter: () => ({}),
}));

vi.mock('@/lib/navigation/prevent-remove', () => ({
  usePreventRemove: usePreventRemoveMock,
}));

let latest: SettingsBackGuardResult | undefined = undefined;

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
  act(() => {
    usePreventRemoveHolder.callback?.({ data: { action } });
  });
  return action;
}

/** The confirm the guard is currently showing, or undefined while none is open. */
function currentDialog(): ConfirmDialogProps | undefined {
  const node = latest?.dialog;
  return isValidElement<ConfirmDialogProps>(node) ? node.props : undefined;
}

async function flushMicrotasks() {
  const { promise, resolve } = Promise.withResolvers<undefined>();
  setTimeout(() => {
    resolve(undefined);
  }, 0);
  await act(async () => {
    await promise;
  });
}

describe('useSettingsBackGuard', () => {
  beforeEach(() => {
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
    expect(currentDialog()).toBeUndefined();
    // The bypass is one-shot: consumed on the removal it armed.
    expect(result.skipNextGuardRef.current).toBe(false);

    act(() => {
      renderer.unmount();
    });
  });

  it('shows Save / Discard / Keep editing for a dirty-valid screen', () => {
    const { renderer } = mountGuard(true, true, noOpSave);

    triggerPreventRemove();
    const dialog = currentDialog();
    expect(dialog?.title).toBe('Unsaved changes');
    expect(dialog?.message).toBe('Save your changes before leaving this screen?');
    // Keep editing is the safe side of the dialog; Save rides between it and
    // the destructive Discard confirm.
    expect(dialog?.cancelLabel).toBe('Keep editing');
    expect(dialog?.extraAction?.label).toBe('Save changes');
    expect(dialog?.confirmLabel).toBe('Discard');
    expect(dispatchMock).not.toHaveBeenCalled();

    act(() => {
      renderer.unmount();
    });
  });

  it('shows Discard / Keep editing for a dirty-invalid screen', () => {
    const { renderer } = mountGuard(true, false, noOpSave);

    triggerPreventRemove();
    const dialog = currentDialog();
    // Nothing valid to persist, so there is no Save action to offer.
    expect(dialog?.extraAction).toBeUndefined();
    expect(dialog?.cancelLabel).toBe('Keep editing');
    expect(dialog?.confirmLabel).toBe('Discard');

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

    const save = currentDialog()?.extraAction;
    expect(save).toBeDefined();

    act(() => {
      save?.onPress();
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

    const save = currentDialog()?.extraAction;
    expect(save).toBeDefined();

    act(() => {
      save?.onPress();
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

    const dialog = currentDialog();
    expect(dialog?.onConfirm).toBeDefined();

    act(() => {
      dialog?.onConfirm();
    });
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(dispatchMock).toHaveBeenCalledWith({ type: 'GO_BACK' });

    act(() => {
      renderer.unmount();
    });
  });

  it('Keep editing dismisses the confirm without saving or leaving', () => {
    const onSave = vi.fn(async () => {
      await Promise.resolve();
    });
    const { renderer } = mountGuard(true, true, onSave);
    triggerPreventRemove();

    const dialog = currentDialog();
    expect(dialog).toBeDefined();

    // The safe choice is the dialog's cancel side: dismissing it drops the
    // captured leave, so nothing is saved and no navigation is replayed.
    act(() => {
      dialog?.onOpenChange(false);
    });

    expect(currentDialog()).toBeUndefined();
    expect(onSave).not.toHaveBeenCalled();
    expect(dispatchMock).not.toHaveBeenCalled();

    act(() => {
      renderer.unmount();
    });
  });
});
