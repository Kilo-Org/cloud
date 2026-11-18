import { createElement, isValidElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type RemoteSessionExitConfirmation,
  useRemoteSessionExitConfirmation,
} from '@/components/agents/remote-session-exit-alert';
import { confirmRemoteSessionExit } from '@/components/agents/remote-session-exit-confirmation';

// The hook builds the in-app destructive confirm; the suite stubs that surface
// so it can read the copy the hook hands it (and both exits) without mounting
// the native Modal.
vi.mock('@/components/destructive-confirm-dialog', () => ({
  DestructiveConfirmDialog: 'DestructiveConfirmDialog',
}));

type ConfirmProps = {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
};

let latest: RemoteSessionExitConfirmation | undefined = undefined;

function Harness() {
  latest = useRemoteSessionExitConfirmation();
  return null;
}

function mount() {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(createElement(Harness));
  });
  if (!ref.current || !latest) {
    throw new Error('exit confirm did not render');
  }
  return { renderer: ref.current, result: latest };
}

/** The confirm the hook is showing, or undefined while none is open. */
function currentDialog(): ConfirmProps | undefined {
  const node = latest?.exitDialog;
  return isValidElement<ConfirmProps>(node) ? node.props : undefined;
}

/** Opens the confirm and hands back the answer the hook is holding. */
function openExit(result: RemoteSessionExitConfirmation): { promise: Promise<boolean> } {
  const pending: { promise?: Promise<boolean> } = {};
  act(() => {
    pending.promise = result.confirmExit();
  });
  const { promise } = pending;
  if (!promise) {
    throw new Error('confirmExit did not return a promise');
  }
  return { promise };
}

describe('useRemoteSessionExitConfirmation', () => {
  beforeEach(() => {
    latest = undefined;
  });

  it('renders the in-app destructive confirm with the exit copy when asked', () => {
    const { renderer, result } = mount();
    // Nothing is mounted until the exit is requested.
    expect(currentDialog()).toBeUndefined();

    act(() => {
      void result.confirmExit();
    });

    expect(currentDialog()).toMatchObject({
      title: 'Exit session?',
      message: 'This stops the running session but keeps its history.',
      confirmLabel: 'Exit session',
      cancelLabel: 'Keep session running',
    });
    act(() => {
      renderer.unmount();
    });
  });

  it('settles once when the destructive callback fires more than once', async () => {
    const exit = vi.fn(async () => {
      await Promise.resolve();
    });
    const { renderer, result } = mount();
    const { promise: confirmation } = openExit(result);
    const dialog = currentDialog();

    act(() => {
      dialog?.onConfirm();
      dialog?.onConfirm();
    });

    await expect(
      confirmRemoteSessionExit(async () => {
        await Promise.resolve();
        return confirmation;
      }, exit)
    ).resolves.toBe('accepted');
    expect(exit).toHaveBeenCalledTimes(1);
    act(() => {
      renderer.unmount();
    });
  });

  it('answers "keep running" on the safe choice and closes the confirm', async () => {
    const { renderer, result } = mount();
    const { promise: confirmation } = openExit(result);

    act(() => {
      currentDialog()?.onCancel();
    });

    await expect(confirmation).resolves.toBe(false);
    expect(currentDialog()).toBeUndefined();
    act(() => {
      renderer.unmount();
    });
  });

  it('answers "keep running" when the host unmounts with the confirm open', async () => {
    const { renderer, result } = mount();
    const { promise: confirmation } = openExit(result);

    act(() => {
      renderer.unmount();
    });

    await expect(confirmation).resolves.toBe(false);
  });
});
