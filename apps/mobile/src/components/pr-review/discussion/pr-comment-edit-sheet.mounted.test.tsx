// Mounted coverage for the own-comment edit sheet: a rejection renders in the
// shared inline box, a retryable one keeps Save live for the same tap, and a
// terminal 404 (the comment is gone) keeps Save down with the sheet's copy.

import { createElement, type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { act, type ReactTestRenderer, TestRenderer } from '@/test/renderer';

import { PrCommentEditSheet } from './pr-comment-edit-sheet';
import { i18n } from '@/i18n';

const { updateComment, gate, connectivity } = vi.hoisted(() => ({
  updateComment: { mutateAsync: vi.fn<(input: unknown) => Promise<unknown>>() },
  gate: { ensureTermsAcceptedOutcome: vi.fn<() => Promise<{ kind: string }>>() },
  connectivity: { value: 'online' },
}));

// The Expo modules in this graph read the build-time `__DEV__` global when they
// load, and this node project does not define it.
vi.hoisted(() => {
  Object.assign(globalThis, { __DEV__: false });
});

vi.mock('react-native', () => ({
  BackHandler: { addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
  Keyboard: { addListener: vi.fn(() => ({ remove: vi.fn() })) },
  ScrollView: 'ScrollView',
  View: 'View',
  TextInput: 'TextInput',
}));

vi.mock('expo-crypto', () => ({ randomUUID: () => 'not-used' }));
vi.mock('expo-haptics', () => ({
  impactAsync: vi.fn(),
  notificationAsync: vi.fn(),
  ImpactFeedbackStyle: { Light: 'Light' },
  NotificationFeedbackType: { Success: 'Success' },
}));

vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/accessible-status', () => ({ AccessibleStatus: 'AccessibleStatus' }));
vi.mock('@/components/pr-review/pr-review-reconnect-notice', () => ({
  PrReviewReconnectNotice: 'PrReviewReconnectNotice',
}));
vi.mock('@/components/ui/dialog', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn(), dialog: null }),
}));
vi.mock('@/components/pr-review/pr-form-sheet-chrome', () => ({
  PrFormSheetHeader: 'PrFormSheetHeader',
  PrFormSheetFooter: 'PrFormSheetFooter',
}));
vi.mock('@/components/pr-review/pr-review-comment-composer-parts', () => ({
  CommentBodyField: 'CommentBodyField',
}));
vi.mock('@/components/pr-review/discussion/reply-input', () => ({
  ensureTermsAcceptedOutcome: gate.ensureTermsAcceptedOutcome,
}));
vi.mock('@/lib/pr-review/discussion/use-pr-comment-crud-mutations', () => ({
  useUpdatePrCommentMutation: () => ({ mutateAsync: updateComment.mutateAsync }),
}));
vi.mock('@/lib/hooks/use-offline-banner-state', () => ({
  getCommittedConnectivityStatus: () => connectivity.value,
}));

const baseProps = {
  owner: 'octocat',
  repo: 'hello',
  number: 1,
  commentId: 7,
  kind: 'conversation' as const,
  initialBody: 'original body',
  onDismiss: vi.fn(),
};

const mounted: ReactTestRenderer[] = [];

async function mount(element: ReactElement): Promise<ReactTestRenderer> {
  const holder: { current: ReactTestRenderer | undefined } = { current: undefined };
  await act(async () => {
    holder.current = TestRenderer.create(element);
    await Promise.resolve();
  });
  const renderer = holder.current;
  if (!renderer) {
    throw new Error('renderer did not mount');
  }
  mounted.push(renderer);
  return renderer;
}

function typeBody(renderer: ReactTestRenderer, text: string): void {
  act(() => {
    (renderer.root.findByType('CommentBodyField').props.onChangeText as (value: string) => void)(
      text
    );
  });
}

function saveButton(renderer: ReactTestRenderer) {
  const [first] = renderer.root.findAll(
    node =>
      Object.is(node.type, 'Button') &&
      node.findAll(child => child.props.children === i18n.t('common.save')).length > 0
  );
  if (!first) {
    throw new Error('missing Save button');
  }
  return first;
}

async function pressSave(renderer: ReactTestRenderer): Promise<void> {
  await act(async () => {
    (saveButton(renderer).props.onPress as () => void)();
  });
}

function saveDisabled(renderer: ReactTestRenderer): boolean {
  return saveButton(renderer).props.disabled as boolean;
}

function failureCopy(renderer: ReactTestRenderer): string | undefined {
  const status = renderer.root.findAllByType('AccessibleStatus')[0];
  const text = renderer.root.findAllByType('Text')[0];
  return (status?.props.message ?? text?.props.children) as string | undefined;
}

beforeEach(() => {
  connectivity.value = 'online';
  updateComment.mutateAsync.mockReset();
  gate.ensureTermsAcceptedOutcome.mockReset();
  gate.ensureTermsAcceptedOutcome.mockResolvedValue({ kind: 'accepted' });
  baseProps.onDismiss = vi.fn();
});

afterEach(() => {
  for (const renderer of mounted.splice(0)) {
    renderer.unmount();
  }
});

describe('PrCommentEditSheet', () => {
  it('saves an edited body and dismisses', async () => {
    updateComment.mutateAsync.mockResolvedValueOnce({});
    const renderer = await mount(createElement(PrCommentEditSheet, baseProps));

    typeBody(renderer, 'edited body');
    expect(saveDisabled(renderer)).toBe(false);
    await pressSave(renderer);

    expect(updateComment.mutateAsync).toHaveBeenCalledWith({
      owner: 'octocat',
      repo: 'hello',
      number: 1,
      commentId: 7,
      kind: 'conversation',
      body: 'edited body',
    });
    expect(baseProps.onDismiss).toHaveBeenCalled();
  });

  it('keeps Save live after a retryable rejection', async () => {
    updateComment.mutateAsync.mockRejectedValueOnce(
      Object.assign(new Error('offline'), { data: { code: 'INTERNAL_SERVER_ERROR' } })
    );
    const renderer = await mount(createElement(PrCommentEditSheet, baseProps));

    typeBody(renderer, 'edited body');
    await pressSave(renderer);

    expect(failureCopy(renderer)).toBe(i18n.t('prReview.discussion.commentEditFailed'));
    expect(saveDisabled(renderer)).toBe(false);
  });

  it('keeps Save down when the comment no longer exists', async () => {
    updateComment.mutateAsync.mockRejectedValueOnce(
      Object.assign(new Error('gone'), { data: { code: 'NOT_FOUND' } })
    );
    const renderer = await mount(createElement(PrCommentEditSheet, baseProps));

    typeBody(renderer, 'edited body');
    await pressSave(renderer);

    expect(failureCopy(renderer)).toBe(i18n.t('prReview.discussion.commentEditUnavailable'));
    expect(saveDisabled(renderer)).toBe(true);

    // Terminal: a comment that no longer exists cannot be saved by editing.
    typeBody(renderer, 'edited body again');
    expect(saveDisabled(renderer)).toBe(true);
  });

  it('does not post while the Terms gate is dismissed', async () => {
    gate.ensureTermsAcceptedOutcome.mockResolvedValue({ kind: 'dismissed' });
    const renderer = await mount(createElement(PrCommentEditSheet, baseProps));

    typeBody(renderer, 'edited body');
    await pressSave(renderer);

    expect(updateComment.mutateAsync).not.toHaveBeenCalled();
    expect(saveDisabled(renderer)).toBe(false);
  });
});
