import React, { createElement, type ReactElement, useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { useSheetDiscardGuard } from '@/components/ui/sheet-discard-guard';
import { act, type ReactTestInstance } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';

type ConfirmRequest = {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
};

const h = vi.hoisted(() => ({
  addEventListener: vi.fn<(event: string, handler: () => boolean) => { remove: () => void }>(
    () => ({
      remove: () => undefined,
    })
  ),
}));

vi.mock('react-native', () => ({
  BackHandler: { addEventListener: h.addEventListener },
}));

// The real confirm is a native sheet whose chrome cannot load in the node test
// renderer. This light double keeps `useConfirmDialog`'s contract: `confirm`
// stores the request, the node renders nothing until asked and exposes the two
// answers as pressables, and each answer clears the request (onConfirm first
// runs the request's action, as the real hook does).
vi.mock('@/components/ui/dialog', () => ({
  useConfirmDialog: () => {
    const [request, setRequest] = useState<ConfirmRequest | null>(null);
    return {
      confirm: setRequest,
      dialog:
        request === null
          ? null
          : createElement(
              'View',
              null,
              createElement('Text', null, request.title),
              createElement('Text', null, request.message),
              createElement('Pressable', {
                accessibilityLabel: request.confirmLabel,
                onPress: () => {
                  setRequest(null);
                  request.onConfirm();
                },
              }),
              createElement('Pressable', {
                accessibilityLabel: request.cancelLabel ?? 'Cancel',
                onPress: () => {
                  setRequest(null);
                },
              })
            ),
    };
  },
}));

const closeRef: { current: () => void } = { current: () => undefined };
const closeSpy: { current: () => void } = { current: () => undefined };

/** Renders the hook's dialog node; exposes `requestClose` on a module ref. */
function Harness({ dirty }: { dirty: boolean }): ReactElement {
  const { requestClose: gateClose, confirmDialog } = useSheetDiscardGuard({
    isDirty: () => dirty,
    // The caller's close: the tests swap `closeSpy` for their assertion spy.
    // A separate ref from the requestClose ref, so closing the form does not
    // re-enter the guard.
    onClose: () => {
      closeSpy.current();
    },
  });
  closeRef.current = gateClose;
  // The dialog node is null while no request is pending; the harness renders
  // it directly, so the tests mount a fragment wrapper to keep a root at all.
  return createElement(React.Fragment, null, confirmDialog);
}

// eslint-disable-next-line typescript-eslint/promise-function-async -- returning the harness promise unchanged
function mountHarness(dirty: boolean) {
  return renderWithProviders(createElement(Harness, { dirty }));
}

function requestClose(): void {
  act(() => {
    closeRef.current();
  });
}

function pressDialogButton(root: ReactTestInstance, label: string): void {
  const pressable = root
    .findAll(node => (node.type as string) === 'Pressable')
    .find(node => node.props.accessibilityLabel === label);
  if (!pressable) {
    throw new Error(`dialog button ${label} was not rendered`);
  }
  act(() => {
    (pressable.props as { onPress: () => void }).onPress();
  });
}

describe('useSheetDiscardGuard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('closes a clean form without asking', async () => {
    const onClose = vi.fn<() => void>();
    closeSpy.current = onClose;
    const { unmount } = await mountHarness(false);

    requestClose();

    expect(onClose).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('asks before discarding a dirty form: Discard closes, Keep editing does not', async () => {
    const onClose = vi.fn<() => void>();
    closeSpy.current = onClose;
    const { renderer, unmount } = await mountHarness(true);

    requestClose();

    expect(onClose).not.toHaveBeenCalled();
    const texts = renderer.root
      .findAll(node => typeof node.props.children === 'string')
      .map(node => node.props.children as string);
    expect(texts).toContain('Discard changes?');
    expect(texts).toContain('Your changes will be lost.');

    // Keep editing: nothing closes.
    pressDialogButton(renderer.root, 'Keep editing');
    expect(onClose).not.toHaveBeenCalled();

    // Discard: the caller's close runs.
    requestClose();
    pressDialogButton(renderer.root, 'Discard');
    expect(onClose).toHaveBeenCalledTimes(1);

    unmount();
  });

  it('registers hardware Back for the sheet lifetime and consumes the event', async () => {
    const onClose = vi.fn<() => void>();
    closeSpy.current = onClose;
    const { unmount } = await mountHarness(false);

    expect(h.addEventListener).toHaveBeenCalledTimes(1);
    const firstCall = h.addEventListener.mock.calls.at(0);
    if (!firstCall) {
      throw new Error('hardwareBackPress listener was not registered');
    }
    const [event, handler] = firstCall;
    expect(event).toBe('hardwareBackPress');
    // Consumed: the underlying screen must not pop behind the sheet.
    expect(handler()).toBe(true);
    // The Back press routes through the same gate (clean here, so close).
    expect(onClose).toHaveBeenCalledTimes(1);

    unmount();
  });
});
