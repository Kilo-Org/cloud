/* eslint-disable typescript-eslint/no-deprecated -- DOM-free mounted React Native assertions. */
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { act, type ReactTestInstance, TestRenderer } from '@/test/renderer';

import { useSheetDismissGuard } from './use-sheet-dismiss-guard';

// The confirm node is the native dialog, covered by its own suite; here it is a
// marker so the assertions stay on the gate's decisions.
const confirmMock = vi.hoisted(() => ({
  requests: [] as {
    title: string;
    message: string;
    confirmLabel: string;
    cancelLabel?: string;
    onConfirm: () => void;
  }[],
}));

vi.mock('@/components/ui/dialog', () => ({
  useConfirmDialog: () => ({
    confirm: (request: (typeof confirmMock.requests)[number]) => {
      confirmMock.requests.push(request);
    },
    dialog: 'ConfirmDialog',
  }),
}));

/** A host stub keeps the component's own props untyped; these suites call one handler each. */
function voidHandler(value: unknown): () => void {
  if (typeof value !== 'function') {
    throw new TypeError('expected a handler prop');
  }
  return value as () => void;
}

/** The sheet's dismissal request answers whether it may close. */
function booleanHandler(value: unknown): () => boolean {
  if (typeof value !== 'function') {
    throw new TypeError('expected a handler prop');
  }
  return value as () => boolean;
}

type HarnessProps = Readonly<{
  isDirty: () => boolean;
  onDiscard: () => void;
}>;

function Harness({ isDirty, onDiscard }: HarnessProps) {
  const { requestClose, requestDismiss, dialog } = useSheetDismissGuard({ isDirty, onDiscard });
  return createElement('View', {
    testID: 'sheet-dismiss-guard',
    requestClose,
    requestDismiss,
    hasDialog: dialog !== null,
  });
}

function mount(props: HarnessProps): TestRenderer.ReactTestInstance {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(createElement(Harness, props));
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer.root;
}

function harnessNode(root: ReactTestInstance): ReactTestInstance {
  return root.find(node => node.props.testID === 'sheet-dismiss-guard');
}

function call(root: ReactTestInstance, name: 'requestClose' | 'requestDismiss'): void {
  const handler = voidHandler(harnessNode(root).props[name]);
  act(() => {
    handler();
  });
}

beforeEach(() => {
  confirmMock.requests.length = 0;
});

describe('useSheetDismissGuard', () => {
  it('closes a clean form without asking', () => {
    const onDiscard = vi.fn<() => void>();
    const root = mount({ isDirty: () => false, onDiscard });

    call(root, 'requestClose');

    expect(onDiscard).toHaveBeenCalledTimes(1);
    expect(confirmMock.requests).toHaveLength(0);
    // A native request for a clean form is allowed; the sheet closes itself.
    expect(booleanHandler(harnessNode(root).props.requestDismiss)()).toBe(true);
    expect(confirmMock.requests).toHaveLength(0);
  });

  it('asks Keep editing / Discard and only discards on the confirm', () => {
    const onDiscard = vi.fn<() => void>();
    const root = mount({ isDirty: () => true, onDiscard });

    call(root, 'requestClose');

    expect(onDiscard).not.toHaveBeenCalled();
    expect(confirmMock.requests).toHaveLength(1);
    const request = confirmMock.requests[0];
    expect(request?.title).toBe(i18n.t('common.discardChangesTitle'));
    expect(request?.message).toBe(i18n.t('common.discardChangesMessage'));
    expect(request?.confirmLabel).toBe(i18n.t('common.discard'));
    expect(request?.cancelLabel).toBe(i18n.t('common.keepEditing'));

    act(() => {
      request?.onConfirm();
    });
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });

  it('refuses a native dismissal while dirty, so the sheet stays up for the confirm', () => {
    const onDiscard = vi.fn<() => void>();
    const root = mount({ isDirty: () => true, onDiscard });

    let allowed = true;
    act(() => {
      allowed = booleanHandler(harnessNode(root).props.requestDismiss)();
    });

    expect(allowed).toBe(false);
    expect(onDiscard).not.toHaveBeenCalled();
    expect(confirmMock.requests).toHaveLength(1);
  });

  it('reads dirtiness when the dismissal happens, not when the sheet rendered', () => {
    const onDiscard = vi.fn<() => void>();
    let dirty = false;
    const root = mount({ isDirty: () => dirty, onDiscard });

    // Fields are uncontrolled: the user types after the last render.
    dirty = true;
    call(root, 'requestClose');

    expect(confirmMock.requests).toHaveLength(1);
    expect(onDiscard).not.toHaveBeenCalled();
  });
});
