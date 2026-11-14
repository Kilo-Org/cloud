/* eslint-disable max-lines -- the admission, clearing and blocking rules share one mounted conversation harness */
// Mounted coverage for the PR conversation composer: one admitted submit, the
// empty-body validation, and the two rejection policies (a server bad-request
// stays retryable, the ledger persistence marker blocks until an edit).

import { createElement, type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { act, type ReactTestRenderer, TestRenderer } from '@/test/renderer';

import { PrConversationCommentComposer } from './pr-conversation-comment-composer';
import { i18n } from '@/i18n';
import { PR_OPERATION_PERSISTENCE_FAILED_MESSAGE } from '@/lib/pr-review/merge/pr-operation-ledger';
import { clearDraft } from '@/lib/persist/drafts';

const { addComment, gate, connectivity } = vi.hoisted(() => ({
  addComment: { mutateAsync: vi.fn<(input: unknown) => Promise<unknown>>() },
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
  useFormSheetKeyboardVisible: () => false,
}));
vi.mock('@/components/pr-review/pr-review-comment-composer-parts', () => ({
  CommentBodyField: 'CommentBodyField',
  ComposerFooter: 'ComposerFooter',
  composerRangeLabel: () => 'L1',
  ContextPreview: 'ContextPreview',
}));

vi.mock('@/components/pr-review/discussion/reply-input', () => ({
  ensureTermsAcceptedOutcome: gate.ensureTermsAcceptedOutcome,
}));
vi.mock('@/lib/pr-review/discussion/use-review-discussion-mutations', () => ({
  useAddPrCommentMutation: () => ({ mutateAsync: addComment.mutateAsync }),
}));
vi.mock('@/lib/hooks/use-current-user-id', () => ({
  useCurrentUserId: () => ({ userId: 'u1', isLoading: false }),
}));
vi.mock('@/lib/hooks/use-offline-banner-state', () => ({
  getCommittedConnectivityStatus: () => connectivity.value,
}));
vi.mock('@/lib/persist/drafts', () => ({
  saveDraft: vi.fn(),
  clearDraft: vi.fn(),
  prConversationCommentDraftKey: () => 'pr-conversation:key',
}));
vi.mock('@/lib/persist/use-draft-load', () => ({
  useFencedDraftLoad: () => ({ settled: true, value: null }),
}));
vi.mock('@/lib/persist/use-draft-flush', () => ({ useDraftFlushOnBackground: vi.fn() }));

const baseProps = {
  owner: 'octocat',
  repo: 'hello',
  number: 1,
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

function commentButton(renderer: ReactTestRenderer) {
  const [first] = renderer.root.findAll(
    node =>
      Object.is(node.type, 'Button') &&
      node.findAll(child => child.props.children === i18n.t('prReview.composer.comment')).length > 0
  );
  if (!first) {
    throw new Error('missing Comment button');
  }
  return first;
}

function pressComment(renderer: ReactTestRenderer): void {
  act(() => {
    (commentButton(renderer).props.onPress as () => void)();
  });
}

function commentDisabled(renderer: ReactTestRenderer): boolean {
  return commentButton(renderer).props.disabled as boolean;
}

function failureCopy(renderer: ReactTestRenderer): string | undefined {
  const status = renderer.root.findAllByType('AccessibleStatus')[0];
  const text = renderer.root.findAllByType('Text')[0];
  return (status?.props.message ?? text?.props.children) as string | undefined;
}

beforeEach(() => {
  connectivity.value = 'online';
  addComment.mutateAsync.mockReset();
  gate.ensureTermsAcceptedOutcome.mockReset();
  gate.ensureTermsAcceptedOutcome.mockResolvedValue({ kind: 'accepted' });
  vi.mocked(clearDraft).mockReset();
  baseProps.onDismiss = vi.fn();
});

afterEach(() => {
  for (const renderer of mounted.splice(0)) {
    renderer.unmount();
  }
});

describe('PrConversationCommentComposer', () => {
  it('issues one request for two taps during the Terms status round-trip', async () => {
    const roundTrip = Promise.withResolvers<{ kind: string }>();
    gate.ensureTermsAcceptedOutcome.mockReturnValueOnce(roundTrip.promise);
    addComment.mutateAsync.mockResolvedValueOnce({});
    const renderer = await mount(createElement(PrConversationCommentComposer, baseProps));
    typeBody(renderer, 'hello');

    pressComment(renderer);
    pressComment(renderer);
    expect(commentDisabled(renderer)).toBe(true);

    await act(async () => {
      roundTrip.resolve({ kind: 'accepted' });
      await Promise.resolve();
    });

    expect(addComment.mutateAsync).toHaveBeenCalledTimes(1);
    expect(addComment.mutateAsync).toHaveBeenCalledWith({
      owner: 'octocat',
      repo: 'hello',
      number: 1,
      body: 'hello',
    });
    expect(clearDraft).toHaveBeenCalledWith('u1', 'pr-conversation:key');
    expect(baseProps.onDismiss).toHaveBeenCalled();
  });

  it('enables Comment once a typed body replaces an empty submit', async () => {
    addComment.mutateAsync.mockResolvedValueOnce({});
    const renderer = await mount(createElement(PrConversationCommentComposer, baseProps));

    pressComment(renderer);
    expect(failureCopy(renderer)).toBe(i18n.t('prReview.composer.bodyEmpty'));
    expect(commentDisabled(renderer)).toBe(true);

    typeBody(renderer, 'a valid body');
    expect(commentDisabled(renderer)).toBe(false);

    await act(async () => {
      pressComment(renderer);
    });
    expect(addComment.mutateAsync).toHaveBeenCalledTimes(1);
  });

  it('keeps Comment live after a server bad-request so the retry needs no retyping', async () => {
    addComment.mutateAsync.mockRejectedValueOnce(
      Object.assign(new Error('stale'), { data: { code: 'BAD_REQUEST' } })
    );
    const renderer = await mount(createElement(PrConversationCommentComposer, baseProps));
    typeBody(renderer, 'hello');

    await act(async () => {
      pressComment(renderer);
    });

    expect(failureCopy(renderer)).toBe(i18n.t('prReview.mutationError.commentNotPosted'));
    expect(commentDisabled(renderer)).toBe(false);
  });

  it('blocks Comment on the ledger persistence marker until the next keystroke', async () => {
    addComment.mutateAsync.mockRejectedValueOnce(
      new Error(PR_OPERATION_PERSISTENCE_FAILED_MESSAGE)
    );
    const renderer = await mount(createElement(PrConversationCommentComposer, baseProps));
    typeBody(renderer, 'hello');

    await act(async () => {
      pressComment(renderer);
    });

    expect(failureCopy(renderer)).toBe(i18n.t('common.actionNotRecorded'));
    expect(commentDisabled(renderer)).toBe(true);

    typeBody(renderer, 'hello again');
    expect(commentDisabled(renderer)).toBe(false);
    expect(renderer.root.findAllByType('AccessibleStatus')).toHaveLength(0);
  });
});
