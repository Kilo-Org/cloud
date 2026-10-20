/**
 * Mounted harness for the new-session discard guard.
 *
 * The confirm the hook returns is the real `DestructiveConfirmDialog`, which
 * presents a native sheet, so this module stubs the primitives that dialog's own
 * mounted suite stubs and drives the same boundary: a press only starts the
 * dismissal, and the pressed choice runs when the sheet reports it. The mocks
 * live here with the harness so the suite reads as a list of behaviours.
 */
import { createElement, Fragment, type RefObject } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { vi } from 'vitest';

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
  callback: undefined as
    | ((options: { data: { action: Action }; repeat: () => void }) => void)
    | undefined,
}));

const usePreventRemoveMock = vi.hoisted(() =>
  vi.fn(
    (
      preventRemove: boolean,
      handler: (options: { data: { action: Action }; repeat: () => void }) => void
    ) => {
      usePreventRemoveHolder.preventRemove = preventRemove;
      usePreventRemoveHolder.callback = handler;
    }
  )
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

export async function noOpDiscard(): Promise<void> {
  await Promise.resolve();
}

/** Mounts the guard and returns its renderer plus the caller-owned skip ref. */
export function mountGuard(dirty: boolean, onDiscard: () => Promise<void>) {
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

/** Mounts the guard for an empty prompt that still holds admitted uploads. */
export function mountGuardWithAttachments() {
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

/** Fires the captured leave outside `act`; the hook's handler runs synchronously. */
export function triggerPreventRemove(): Action {
  const action = { type: 'GO_BACK' };
  usePreventRemoveHolder.callback?.({
    data: { action },
    repeat: () => {
      dispatchMock(action);
    },
  });
  return action;
}

/** Triggers a leave inside `act` so the confirm's state update flushes. */
export function triggerPreventRemoveInAct(): Action {
  const holder: { action: Action } = { action: { type: 'GO_BACK' } };
  act(() => {
    holder.action = triggerPreventRemove();
  });
  return holder.action;
}

/** Returns every hoisted mock and the captured removal to its pre-test state. */
export function resetGuardHarness(): void {
  platform.os = 'ios';
  alertMock.mockReset();
  dispatchMock.mockReset();
  toastErrorMock.mockReset();
  usePreventRemoveMock.mockReset();
  usePreventRemoveHolder.preventRemove = undefined;
  usePreventRemoveHolder.callback = undefined;
}

export function isType(node: TestRenderer.ReactTestInstance, type: string): boolean {
  return typeof node.type === 'string' && node.type === type;
}

export function classNameOf(node: TestRenderer.ReactTestInstance): string {
  return typeof node.props.className === 'string' ? node.props.className : '';
}

/** Every string rendered through a `Text` node, in tree order. */
export function renderedLabels(renderer: TestRenderer.ReactTestRenderer): string[] {
  return renderer.root
    .findAll(node => isType(node, 'Text'))
    .flatMap(node => node.children.filter((child): child is string => typeof child === 'string'));
}

/**
 * Presses the dialog control whose button variant carries `token` (the
 * destructive fill or the neutral outline), by the same class-based lookup the
 * dialog's own mounted test uses.
 */
export function pressDialogButton(renderer: TestRenderer.ReactTestRenderer, token: string) {
  const node = renderer.root.find(
    candidate => isType(candidate, 'Pressable') && classNameOf(candidate).includes(token)
  );
  callProp(node, 'onPress');
}

/**
 * Reports the native sheet's own dismissal, which is the moment the pressed
 * choice runs. The confirm is a native sheet, so a press only starts the
 * dismissal: it keeps the request on screen and hands the action to
 * `onDismiss`, exactly as the sheet does on device.
 */
export function dismissDialogSheet(renderer: TestRenderer.ReactTestRenderer) {
  const sheet = renderer.root.find(node => isType(node, 'BottomSheet'));
  callProp(sheet, 'onDismiss');
}

/**
 * Calls one of a mounted element's own props inside `act`. The test renderer
 * leaves `props` untyped, and this suite only ever calls handlers it would
 * otherwise fire by hand, so the shape is guarded here instead of assumed.
 */
function callProp(node: TestRenderer.ReactTestInstance, name: string): void {
  const prop = node.props[name] as (() => void) | undefined;
  if (typeof prop !== 'function') {
    throw new TypeError(`The element has no callable ${name}`);
  }
  act(() => {
    prop();
  });
}

export async function flushMicrotasks() {
  const { promise, resolve } = Promise.withResolvers<undefined>();
  await act(async () => {
    setTimeout(() => {
      resolve(undefined);
    }, 0);
    await promise;
  });
}

export {
  alertMock,
  dispatchMock,
  platform,
  PLATFORMS,
  toastErrorMock,
  usePreventRemoveHolder,
  usePreventRemoveMock,
};
