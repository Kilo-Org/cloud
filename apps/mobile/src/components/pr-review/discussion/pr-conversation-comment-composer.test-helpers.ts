// Test support for pr-conversation-comment-composer.test.tsx: the module-mock
// harness, the shared fixtures, and the element-query helpers. The composer is
// mounted as a plain function (no renderer), mirroring
// pr-review-comment-composer.test.tsx; the React hook stub below keeps one
// state box per hook slot: a setter writes the box, the next mount call reads
// it back.
//
// The vi.mock registrations in this module body run while it is evaluated —
// which is why the test file must import this module FIRST, before the
// composer, '@/i18n', or any other module that has to resolve against these
// mocks.

import * as React from 'react';
import type * as ReactI18next from 'react-i18next';
import { expect, vi } from 'vitest';

type AlertButton = { text?: string; style?: string; onPress?: () => void };
export type AlertCall = { title: string; message: string; buttons: AlertButton[] };
export type InlineErrorProps = {
  inlineError?: string;
  inlineErrorKind?: string;
  inlineErrorIsLocal?: boolean;
};
/** A dismissal trigger: the control the user presses to leave the composer. */
export type Trigger = (element: React.ReactElement) => void;

const hoisted = vi.hoisted(() => ({
  hookState: { boxes: [] as unknown[], cursor: 0 },
  alertCalls: [] as AlertCall[],
  addCommentMocks: {
    mutateAsync: vi.fn<() => Promise<unknown>>(),
    isPending: false,
    error: null as unknown,
  },
  draftLoadMock: vi.fn((): { settled: boolean; value: string | null } => ({
    settled: true,
    value: null,
  })),
  termsGateMock: vi.fn(),
  // The composer arms the hardware-back listener once per mount on every
  // platform (no fork); the test invokes the captured handler directly.
  backHandler: { current: null as null | (() => boolean) },
  platformMock: { OS: 'ios' as string },
  // The ledger persistence-failure marker is the one server failure that
  // keeps Comment down; the marker check is flipped per test.
  persistenceFailed: { value: false },
  // The ledger ambiguous marker flips the same way: the verify-before-
  // retrying copy, never the generic retryable one.
  ambiguous: { value: false },
  // The committed connectivity the submit gate reads. 'online' by default;
  // the offline-gate tests flip it to 'offline'.
  connectivity: { value: 'online' as 'online' | 'offline' | 'unknown' },
}));

export const hookState = hoisted.hookState;
export const alertCalls = hoisted.alertCalls;
export const addCommentMocks = hoisted.addCommentMocks;
export const draftLoadMock = hoisted.draftLoadMock;
export const termsGateMock = hoisted.termsGateMock;
export const backHandler = hoisted.backHandler;
export const platformMock = hoisted.platformMock;
export const persistenceFailed = hoisted.persistenceFailed;
export const ambiguous = hoisted.ambiguous;
export const connectivity = hoisted.connectivity;

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
    useState: vi.fn(<T>(initial: T) => {
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
    useMemo: vi.fn(<T>(factory: () => T) => factory()),
    useRef: vi.fn(<T>(initial: T) => {
      const ref: React.RefObject<T> = { current: initial };
      return ref;
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
  Platform: platformMock,
}));

vi.mock('expo-haptics', () => ({
  notificationAsync: vi.fn(),
  NotificationFeedbackType: { Success: 'Success' },
}));

vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));

vi.mock('@/components/pr-review/pr-form-sheet-chrome', () => ({
  PrFormSheetHeader: 'PrFormSheetHeader',
  PrFormSheetFooter: 'PrFormSheetFooter',
}));

vi.mock('@/components/pr-review/composer-inline-error', () => ({
  ComposerInlineError: 'ComposerInlineError',
}));

vi.mock('@/components/pr-review/pr-review-comment-composer-parts', () => ({
  CommentBodyField: 'CommentBodyField',
}));

vi.mock('@/components/pr-review/discussion/reply-input', () => ({
  ensureTermsAcceptedOutcome: termsGateMock,
}));

vi.mock('@/lib/hooks/use-current-user-id', () => ({
  useCurrentUserId: () => ({ userId: 'u1', isLoading: false }),
}));

vi.mock('@/lib/persist/drafts', () => ({
  saveDraft: vi.fn(),
  clearDraft: vi.fn(),
  prConversationCommentDraftKey: vi.fn(() => 'pr-conversation-comment:key'),
}));

vi.mock('@/lib/persist/use-draft-load', () => ({
  useFencedDraftLoad: () => draftLoadMock(),
}));

vi.mock('@/lib/persist/use-draft-flush', () => ({
  useDraftFlushOnBackground: vi.fn(),
}));

vi.mock('@/lib/pr-review/merge/pr-operation-ledger', () => ({
  isPrOperationPersistenceFailed: () => persistenceFailed.value,
  isPrOperationAmbiguous: () => ambiguous.value,
}));

// The submit gate reads the committed connectivity snapshot. The real module
// pulls in NetInfo + the app's own probe store, which the node environment
// cannot resolve; the gate's decision is flipped per test instead.
vi.mock('@/lib/hooks/use-offline-banner-state', () => ({
  getCommittedConnectivityStatus: () => connectivity.value,
}));

vi.mock('@/lib/pr-review/discussion/use-review-discussion-mutations', () => ({
  useAddPrCommentMutation: () => addCommentMocks,
}));

// The two in-sheet dismissal triggers; the hardware-back trigger needs the
// harness's listener capture, so it joins them in dismissTriggers below.
export const footerCancelTrigger: Trigger = element => {
  pressButton(element, 'Cancel');
};
const headerCloseTrigger: Trigger = element => {
  (requireByType(element, 'PrFormSheetHeader').props as { onBack?: () => void }).onBack?.();
};

/** Presses the Button whose accessibilityLabel matches. */
export function pressButton(element: React.ReactElement, label: string): void {
  const button = buttonByLabel(element, label);
  (button.props as { onPress?: () => void }).onPress?.();
}

/** Returns the Button whose accessibilityLabel matches, failing when absent. */
export function buttonByLabel(element: React.ReactElement, label: string): React.ReactElement {
  const button = findAllByType(element, 'Button').find(
    candidate => (candidate.props as { accessibilityLabel?: string }).accessibilityLabel === label
  );
  if (!button) {
    throw new Error(`Button "${label}" not found`);
  }
  return button;
}

/** Types into the mounted composer's body field. */
export function typeBody(element: React.ReactElement, text: string): void {
  const field = requireByType(element, 'CommentBodyField');
  (field.props as { onChangeText?: (value: string) => void }).onChangeText?.(text);
}

/** Presses the discard Alert's Keep editing button. */
export function pressKeepEditing(call: AlertCall): void {
  call.buttons.find(button => button.text === 'Keep editing')?.onPress?.();
}

/** Presses the discard Alert's destructive Discard button. */
export function pressDiscard(call: AlertCall): void {
  call.buttons.find(button => button.style === 'destructive')?.onPress?.();
}

/** Drains the microtask queue plus one macrotask tick. */
export async function flushMicrotasks(): Promise<void> {
  await new Promise(resolve => {
    setTimeout(resolve, 0);
  });
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

export function requireByType(node: unknown, type: string): React.ReactElement {
  const element = findAllByType(node, type)[0];
  if (!element) {
    throw new Error(`${type} not found`);
  }
  return element;
}

export const baseProps = { owner: 'octocat', repo: 'hello', number: 7, onDismiss: vi.fn() };

export const DRAFT_KEY = 'pr-conversation-comment:key';

// The three dismissal triggers (footer Cancel, header close, hardware back —
// armed by every mount, on every platform) must run the same gate. The back
// trigger also asserts the event is consumed: handleCancel owns the pop, so
// the router must not dismiss the sheet a second time under the dialog.
export const dismissTriggers: readonly (readonly [string, Trigger])[] = [
  ['the footer Cancel', footerCancelTrigger],
  ['the header close', headerCloseTrigger],
  [
    'the hardware back',
    () => {
      expect(backHandler.current?.()).toBe(true);
    },
  ],
];

/** Returns the last recorded Alert call, failing when none was shown. */
export const lastAlert = (): AlertCall => {
  const call = alertCalls.at(-1);
  if (!call) {
    throw new Error('No discard Alert was shown');
  }
  return call;
};
