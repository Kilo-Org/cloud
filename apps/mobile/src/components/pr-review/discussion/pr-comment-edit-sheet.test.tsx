// Read / update / failure-state coverage for the own-comment edit sheet.
// Mounted as a plain function (no renderer), mirroring
// pr-review-comment-composer.test.tsx: the React hook primitives are stubbed
// with one state box / ref slot per hook position, so a re-mount reads back
// what the previous render wrote. The real `useComposerInlineError` is kept
// (only its `ComposerInlineError` view is stubbed) so the surface-specific
// error copy is exercised end to end.
/* eslint-disable max-lines -- one file for the module-mock harness, the element-query helpers and the read/update/failure states, mirroring pr-review-comment-composer.test.tsx */

import * as React from 'react';
import type * as ReactI18next from 'react-i18next';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ComposerInlineErrorModule from '@/components/pr-review/composer-inline-error';
import '@/i18n';
import * as Haptics from 'expo-haptics';
import { PrCommentEditSheet } from './pr-comment-edit-sheet';

type AlertButton = { text?: string; style?: string; onPress?: () => void };
type AlertCall = { title: string; message: string; buttons: AlertButton[] };
type InlineErrorProps = {
  inlineError?: string;
  inlineErrorKind?: string;
  inlineErrorIsLocal?: boolean;
};

const hoisted = vi.hoisted(() => ({
  hookState: {
    boxes: [] as unknown[],
    cursor: 0,
    refSlots: [] as { current: unknown }[],
    refCursor: 0,
  },
  alertCalls: [] as AlertCall[],
  updateCommentMocks: {
    mutateAsync: vi.fn<() => Promise<unknown>>(),
    isPending: false,
    error: null as unknown,
  },
  termsGateMock: vi.fn(),
  backHandler: { current: null as null | (() => boolean) },
  // The committed connectivity the submit gate reads; 'online' by default,
  // flipped per test. The real module pulls in NetInfo + the probe store,
  // which the node environment cannot resolve.
  connectivity: { value: 'online' as 'online' | 'offline' | 'unknown' },
}));

const { hookState, alertCalls, updateCommentMocks, termsGateMock, backHandler, connectivity } =
  hoisted;

vi.mock('react-i18next', async importOriginal => {
  const actual = await importOriginal<typeof ReactI18next>();
  return {
    ...actual,
    useTranslation: () => {
      const i18n = actual.getI18n();
      return { t: i18n.t.bind(i18n), i18n };
    },
  };
});

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof React>('react');
  return {
    ...actual,
    useState: vi.fn(<T,>(initial: T) => {
      const index = hookState.cursor;
      hookState.cursor += 1;
      if (hookState.boxes.length <= index) {
        hookState.boxes.push(initial);
      }
      const write = (value: T) => {
        hookState.boxes[index] = value;
      };
      return [hookState.boxes[index] as T, write] as [T, (value: T) => void];
    }),
    useMemo: vi.fn(<T,>(factory: () => T) => factory()),
    // Refs persist across re-renders in React, so the harness keeps one slot
    // per hook position: the uncontrolled body field's text survives the
    // re-mount that mirrors a failed write.
    useRef: vi.fn(<T,>(initial: T) => {
      const index = hookState.refCursor;
      hookState.refCursor += 1;
      if (hookState.refSlots.length <= index) {
        hookState.refSlots.push({ current: initial });
      }
      return hookState.refSlots[index] as unknown as React.RefObject<T>;
    }),
    useEffect: vi.fn((effect: React.EffectCallback) => {
      effect();
    }),
    useCallback: vi.fn(<T extends (...args: never[]) => unknown>(fn: T) => fn),
  };
});

vi.mock('react-native', () => ({
  Alert: {
    alert: (title: string, message: string, buttons: AlertCall['buttons']) => {
      alertCalls.push({ title, message, buttons });
    },
  },
  BackHandler: {
    addEventListener: (event: string, handler: () => boolean) => {
      const armed = event === 'hardwareBackPress';
      if (armed) {
        backHandler.current = handler;
      }
      return {
        remove: () => {
          if (armed) {
            backHandler.current = null;
          }
        },
      };
    },
  },
  Keyboard: { addListener: vi.fn(() => ({ remove: vi.fn() })) },
  ScrollView: 'ScrollView',
  View: 'View',
  TextInput: 'TextInput',
  Platform: { OS: 'ios' },
}));

vi.mock('expo-haptics', () => ({
  notificationAsync: vi.fn(),
  NotificationFeedbackType: { Success: 'Success' },
}));

// The real `useComposerInlineError` (kept below) reaches the operation-ledger
// helpers, which import `expo-crypto`; mock it so this pure suite stays
// node-only, like the ledger's own pure tests.
vi.mock('expo-crypto', () => ({ randomUUID: () => 'not-used' }));

vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/accessible-status', () => ({ AccessibleStatus: 'AccessibleStatus' }));
vi.mock('@/components/pr-review/pr-review-reconnect-notice', () => ({
  PrReviewReconnectNotice: 'PrReviewReconnectNotice',
}));

vi.mock('@/components/pr-review/pr-form-sheet-chrome', () => ({
  PrFormSheetHeader: 'PrFormSheetHeader',
  PrFormSheetFooter: 'PrFormSheetFooter',
}));

vi.mock('@/components/pr-review/pr-review-comment-composer-parts', () => ({
  CommentBodyField: 'CommentBodyField',
}));

vi.mock('@/components/pr-review/discussion/reply-input', () => ({
  // Reference the hoisted object, not the destructured const: the factory is
  // hoisted above the module body and runs during the sheet's import.
  ensureTermsAcceptedOutcome: hoisted.termsGateMock,
}));

vi.mock('@/lib/pr-review/discussion/use-pr-comment-crud-mutations', () => ({
  useUpdatePrCommentMutation: () => hoisted.updateCommentMocks,
}));

// The submit gate reads the committed connectivity; the real module reaches
// NetInfo, which this node-environment suite cannot resolve.
vi.mock('@/lib/hooks/use-offline-banner-state', () => ({
  getCommittedConnectivityStatus: () => hoisted.connectivity.value,
}));

// The sheet's own-comment write path is mocked above; the trpc module is
// mocked too so nothing in this node-environment suite reaches the real
// client (the composer suite's harness does the same).
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({}),
  trpcClient: {},
}));

// Keep the real `useComposerInlineError` (the copy under test) and stub only
// the view so the element tree exposes its props.
vi.mock('@/components/pr-review/composer-inline-error', async importOriginal => {
  const actual = await importOriginal<typeof ComposerInlineErrorModule>();
  return { ...actual, ComposerInlineError: 'ComposerInlineError' };
});

const baseProps = {
  owner: 'octocat',
  repo: 'hello',
  number: 7,
  commentId: 42,
  kind: 'review' as const,
  initialBody: 'original body',
  onDismiss: vi.fn(),
};

function mountSheet(): React.ReactElement {
  // One render pass per mount call: the cursor restarts at 0 while the boxes
  // and ref slots persist, mirroring React's state/refs-across-renders
  // semantics.
  hookState.cursor = 0;
  hookState.refCursor = 0;
  // eslint-disable-next-line new-cap
  return PrCommentEditSheet({ ...baseProps });
}

function findAllByType(node: unknown, type: string): React.ReactElement[] {
  const found: React.ReactElement[] = [];
  const walk = (current: unknown): void => {
    if (Array.isArray(current)) {
      for (const child of current) {
        walk(child);
      }
      return;
    }
    if (!React.isValidElement(current)) {
      return;
    }
    if (current.type === type) {
      found.push(current);
    }
    const children = (current.props as Record<string, unknown>).children;
    if (Array.isArray(children)) {
      for (const child of children) {
        walk(child);
      }
    } else if (children != null) {
      walk(children);
    }
  };
  walk(node);
  return found;
}

function requireByType(node: unknown, type: string): React.ReactElement {
  const element = findAllByType(node, type)[0];
  if (!element) {
    throw new Error(`${type} not found`);
  }
  return element;
}

/** Returns the Button whose accessibilityLabel matches, failing when absent. */
function buttonByLabel(element: React.ReactElement, label: string): React.ReactElement {
  const button = findAllByType(element, 'Button').find(
    candidate => (candidate.props as { accessibilityLabel?: string }).accessibilityLabel === label
  );
  if (!button) {
    throw new Error(`Button "${label}" not found`);
  }
  return button;
}

function pressButton(element: React.ReactElement, label: string): void {
  (buttonByLabel(element, label).props as { onPress?: () => void }).onPress?.();
}

function saveDisabled(element: React.ReactElement): boolean | undefined {
  return (buttonByLabel(element, 'Save').props as { disabled?: boolean }).disabled;
}

/** Types into the mounted sheet's body field. */
function typeBody(element: React.ReactElement, text: string): void {
  const field = requireByType(element, 'CommentBodyField');
  (field.props as { onChangeText?: (value: string) => void }).onChangeText?.(text);
}

/** Presses the discard Alert's Keep editing button. */
function pressKeepEditing(call: AlertCall): void {
  call.buttons.find(button => button.text === 'Keep editing')?.onPress?.();
}

/** Presses the discard Alert's destructive Discard button. */
function pressDiscard(call: AlertCall): void {
  call.buttons.find(button => button.style === 'destructive')?.onPress?.();
}

/** Returns the last recorded Alert call, failing when none was shown. */
function lastAlert(): AlertCall {
  const call = alertCalls.at(-1);
  if (!call) {
    throw new Error('No discard Alert was shown');
  }
  return call;
}

/** Drains the microtask queue plus one macrotask tick. */
async function flushMicrotasks(): Promise<void> {
  await new Promise(resolve => {
    setTimeout(resolve, 0);
  });
}

function codeError(code: string, message: string): Error {
  const error = new Error(message);
  Object.assign(error, { data: { code } });
  return error;
}

describe('PrCommentEditSheet', () => {
  beforeEach(() => {
    hookState.boxes = [];
    hookState.cursor = 0;
    hookState.refSlots = [];
    hookState.refCursor = 0;
    alertCalls.length = 0;
    backHandler.current = null;
    updateCommentMocks.mutateAsync.mockReset();
    updateCommentMocks.isPending = false;
    updateCommentMocks.error = null;
    termsGateMock.mockReset().mockResolvedValue({ kind: 'accepted' });
    connectivity.value = 'online';
    vi.clearAllMocks();
  });

  it('shows the posted comment text in full on open, with Save down for an unchanged body', () => {
    const element = mountSheet();

    const field = requireByType(element, 'CommentBodyField');
    expect((field.props as { defaultValue?: string }).defaultValue).toBe('original body');
    expect(saveDisabled(element)).toBe(true);
  });

  it('enables Save once the body changes', () => {
    let element = mountSheet();
    expect(saveDisabled(element)).toBe(true);

    typeBody(element, 'edited body');
    element = mountSheet();
    expect(saveDisabled(element)).toBe(false);
  });

  it('blocks an empty body with the local validation copy and no request', () => {
    let element = mountSheet();
    typeBody(element, '   ');
    pressButton(element, 'Save');

    expect(updateCommentMocks.mutateAsync).not.toHaveBeenCalled();

    element = mountSheet();
    const inline = requireByType(element, 'ComposerInlineError');
    expect((inline.props as InlineErrorProps).inlineError).toBe('Comment body cannot be empty.');
    expect((inline.props as InlineErrorProps).inlineErrorKind).toBe('bad-request');
    expect((inline.props as InlineErrorProps).inlineErrorIsLocal).toBe(true);
    expect(saveDisabled(element)).toBe(true);
  });

  it('fails a submit while CONFIRMED offline at once with the retryable copy — no request, no spinner, retry offered', async () => {
    // The hang this gate prevents (ux1 spot check, e6-offline-hang): with the
    // offline banner behind the full-height sheet, the tap started a write
    // React Query paused, so the user saw an indefinite spinner with a
    // disabled Cancel and no explanation. The gate rejects locally instead:
    // nothing is pending, the body stays, Save stays live for the retry.
    connectivity.value = 'offline';
    let element = mountSheet();
    typeBody(element, 'edited body');
    pressButton(element, 'Save');

    expect(updateCommentMocks.mutateAsync).not.toHaveBeenCalled();
    expect(termsGateMock).not.toHaveBeenCalled();
    expect(baseProps.onDismiss).not.toHaveBeenCalled();

    element = mountSheet();
    const inline = requireByType(element, 'ComposerInlineError');
    expect((inline.props as InlineErrorProps).inlineError).toBe(
      "Couldn't save your comment. Check your connection and try again."
    );
    expect((inline.props as InlineErrorProps).inlineErrorKind).toBe('retryable');
    // Local rejection: announced through the inline box, not a toast.
    expect((inline.props as InlineErrorProps).inlineErrorIsLocal).toBe(true);
    expect(saveDisabled(element)).toBe(false);

    // Back online: the same control saves the same body.
    connectivity.value = 'online';
    updateCommentMocks.mutateAsync.mockResolvedValueOnce({});
    pressButton(element, 'Save');
    await flushMicrotasks();
    expect(updateCommentMocks.mutateAsync).toHaveBeenCalledWith({
      owner: 'octocat',
      repo: 'hello',
      number: 7,
      commentId: 42,
      kind: 'review',
      body: 'edited body',
    });
  });

  it('sends the edited body to the update mutation and dismisses on success', async () => {
    updateCommentMocks.mutateAsync.mockResolvedValueOnce({});
    const element = mountSheet();
    typeBody(element, 'edited body');
    pressButton(element, 'Save');
    await flushMicrotasks();

    expect(updateCommentMocks.mutateAsync).toHaveBeenCalledWith({
      owner: 'octocat',
      repo: 'hello',
      number: 7,
      commentId: 42,
      kind: 'review',
      body: 'edited body',
    });
    expect(baseProps.onDismiss).toHaveBeenCalledTimes(1);
    expect(Haptics.notificationAsync).toHaveBeenCalledWith(
      Haptics.NotificationFeedbackType.Success
    );
  });

  it('shows the retryable inline copy and preserves the typed text for a retry', async () => {
    const element = mountSheet();
    typeBody(element, 'edited body');
    updateCommentMocks.mutateAsync.mockRejectedValueOnce(new Error('Network request failed'));
    pressButton(element, 'Save');
    await flushMicrotasks();
    expect(baseProps.onDismiss).not.toHaveBeenCalled();

    // The failed mutation error is preserved on the hook, so the next render
    // mirrors it into the inline box (the composer suite's two-mount pattern).
    updateCommentMocks.error = new Error('Network request failed');
    mountSheet();
    const after = mountSheet();

    const inline = requireByType(after, 'ComposerInlineError');
    expect((inline.props as InlineErrorProps).inlineError).toBe('Network request failed');
    expect((inline.props as InlineErrorProps).inlineErrorKind).toBe('retryable');
    expect(saveDisabled(after)).toBe(false);

    // The typed text survived the failure: the same control re-sends it.
    updateCommentMocks.mutateAsync.mockResolvedValueOnce({});
    pressButton(after, 'Save');
    await flushMicrotasks();
    expect(updateCommentMocks.mutateAsync).toHaveBeenLastCalledWith({
      owner: 'octocat',
      repo: 'hello',
      number: 7,
      commentId: 42,
      kind: 'review',
      body: 'edited body',
    });
  });

  it('shows the edit-unavailable copy for a bad request and clears it when the body changes', () => {
    const element = mountSheet();
    typeBody(element, 'edited body');
    updateCommentMocks.error = codeError('BAD_REQUEST', 'Comment is too long');
    mountSheet();
    let after = mountSheet();

    let inline = requireByType(after, 'ComposerInlineError');
    expect((inline.props as InlineErrorProps).inlineError).toBe(
      "This comment can't be edited. It may have been deleted."
    );
    expect((inline.props as InlineErrorProps).inlineErrorKind).toBe('bad-request');
    expect(saveDisabled(after)).toBe(false);

    // Editing the body clears the recoverable bad-request.
    typeBody(after, 'edited again');
    after = mountSheet();
    inline = requireByType(after, 'ComposerInlineError');
    expect((inline.props as InlineErrorProps).inlineError).toBe(null);
  });

  it('shows the forbidden copy and keeps Save down for a permission failure', () => {
    const element = mountSheet();
    typeBody(element, 'edited body');
    updateCommentMocks.error = codeError('FORBIDDEN', 'Repository was archived so is read-only.');
    mountSheet();
    const after = mountSheet();

    const inline = requireByType(after, 'ComposerInlineError');
    expect((inline.props as InlineErrorProps).inlineError).toBe(
      'Repository was archived so is read-only.'
    );
    expect((inline.props as InlineErrorProps).inlineErrorKind).toBe('forbidden');
    expect(saveDisabled(after)).toBe(true);
  });

  it('shows the edit-unavailable copy and keeps Save down when the comment is gone (404)', () => {
    const element = mountSheet();
    typeBody(element, 'edited body');
    updateCommentMocks.error = codeError('NOT_FOUND', 'PR not found, you do not have access');
    mountSheet();
    const after = mountSheet();

    // GitHub 404s a comment that no longer exists: the sheet must not offer a
    // retry that can never succeed.
    const inline = requireByType(after, 'ComposerInlineError');
    expect((inline.props as InlineErrorProps).inlineError).toBe(
      "This comment can't be edited. It may have been deleted."
    );
    expect((inline.props as InlineErrorProps).inlineErrorKind).toBe('not-found');
    expect(saveDisabled(after)).toBe(true);
  });

  it('hands a reconnect classification to the inline notice and keeps Save down', () => {
    const element = mountSheet();
    typeBody(element, 'edited body');
    updateCommentMocks.error = codeError('PRECONDITION_FAILED', 'revoked');
    mountSheet();
    const after = mountSheet();

    // The inline box owns the reconnect notice (the sheet adds none of its
    // own); its recovery CTA lives outside the Save button.
    const inline = requireByType(after, 'ComposerInlineError');
    expect((inline.props as InlineErrorProps).inlineErrorKind).toBe('reconnect');
    expect(saveDisabled(after)).toBe(true);
  });

  it('asks once before discarding a changed body and dismisses on discard', () => {
    let element = mountSheet();
    typeBody(element, 'edited body');
    pressButton(element, 'Cancel');
    expect(lastAlert().buttons.map(button => button.text)).toEqual(['Keep editing', 'Discard']);

    pressKeepEditing(lastAlert());
    expect(baseProps.onDismiss).not.toHaveBeenCalled();

    element = mountSheet();
    typeBody(element, 'edited again');
    pressButton(element, 'Cancel');
    pressDiscard(lastAlert());
    expect(baseProps.onDismiss).toHaveBeenCalledTimes(1);
  });

  it('runs the same discard gate on the header close and the hardware back', () => {
    let element = mountSheet();
    typeBody(element, 'edited body');
    (requireByType(element, 'PrFormSheetHeader').props as { onBack?: () => void }).onBack?.();
    expect(alertCalls).toHaveLength(1);

    element = mountSheet();
    typeBody(element, 'edited again');
    expect(backHandler.current?.()).toBe(true);
    expect(alertCalls).toHaveLength(2);
  });

  it('dismisses an unchanged body without a discard confirm', () => {
    const element = mountSheet();
    pressButton(element, 'Cancel');

    expect(alertCalls).toHaveLength(0);
    expect(baseProps.onDismiss).toHaveBeenCalledTimes(1);
  });

  it('disables the field and shows Save loading while the update is in flight', () => {
    updateCommentMocks.isPending = true;
    const element = mountSheet();

    const field = requireByType(element, 'CommentBodyField');
    expect((field.props as { isDisabled?: boolean }).isDisabled).toBe(true);
    const save = buttonByLabel(element, 'Save');
    expect((save.props as { loading?: boolean }).loading).toBe(true);
    expect((save.props as { disabled?: boolean }).disabled).toBe(true);
  });
});
