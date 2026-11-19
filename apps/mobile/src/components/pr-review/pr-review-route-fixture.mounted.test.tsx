// The fixture's own contract, the part that breaks silently when a screen is
// renamed or a layout changes shape:
//   - every screen link carries the params the real route parses, for both
//     route shapes;
//   - a fixture write settles both composer sheets on their retryable inline
//     failure, keeping the body and the primary control live.
//
// The sheets are mounted for real (real state, real ComposerInlineError); only
// the mutation hook is stubbed, and it rejects with the exact error the
// fixture's client raises.

import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import {
  FIXTURE_WRITE_REFUSED,
  handlePrReviewCopyFixturePath,
} from '@/lib/pr-review/pr-review-copy-fixture-route';
import { act, type ReactTestRenderer } from '@/test/renderer';

import { PrCommentEditSheet } from './discussion/pr-comment-edit-sheet';
import {
  failureCopy as editFailureCopy,
  mount as mountSheet,
  pressSave,
  saveDisabled,
  unmountAll as unmountSheets,
} from './discussion/pr-comment-edit-sheet.test-helpers';
import { PrConversationCommentComposer } from './discussion/pr-conversation-comment-composer';
import {
  buttonByText,
  failureCopy as composerFailureCopy,
  typeBody,
  unmountAll as unmountComposers,
} from './discussion/pr-conversation-comment-composer.test-helpers';

type ConfirmRequest = { readonly onConfirm: () => void };

const { addComment, replace, updateComment, gate, confirmRequests } = vi.hoisted(() => ({
  addComment: { mutateAsync: vi.fn<(input: unknown) => Promise<unknown>>() },
  replace: vi.fn<(href: string) => void>(),
  updateComment: { mutateAsync: vi.fn<(input: unknown) => Promise<unknown>>() },
  gate: { ensureTermsAcceptedOutcome: vi.fn<() => Promise<{ kind: string }>>() },
  confirmRequests: [] as ConfirmRequest[],
}));

// The Expo modules in this graph read the build-time `__DEV__` global when they
// load, and this node project does not define it.
vi.hoisted(() => {
  Object.assign(globalThis, { __DEV__: false });
});

vi.mock('react-native', () => ({
  Alert: { alert: vi.fn() },
  BackHandler: { addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
  Keyboard: { addListener: vi.fn(() => ({ remove: vi.fn() })) },
  ScrollView: 'ScrollView',
  TextInput: 'TextInput',
  View: 'View',
}));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'not-used' }));
vi.mock('expo-haptics', () => ({
  impactAsync: vi.fn(),
  notificationAsync: vi.fn(),
  ImpactFeedbackStyle: { Light: 'Light' },
  NotificationFeedbackType: { Success: 'Success' },
}));
vi.mock('expo-router', () => ({ router: { replace, back: vi.fn() } }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/accessible-status', () => ({ AccessibleStatus: 'AccessibleStatus' }));
vi.mock('@/components/pr-review/pr-review-reconnect-notice', () => ({
  PrReviewReconnectNotice: 'PrReviewReconnectNotice',
}));
vi.mock('@/components/ui/dialog', () => ({
  useConfirmDialog: () => ({
    confirm: (request: ConfirmRequest) => {
      confirmRequests.push(request);
    },
    dialog: null,
  }),
}));
vi.mock('@/components/pr-review/pr-form-sheet-chrome', () => ({
  PrFormSheetHeader: 'PrFormSheetHeader',
  PrFormSheetFooter: 'PrFormSheetFooter',
  useFormSheetKeyboardVisible: () => false,
}));
vi.mock('@/components/pr-review/pr-review-comment-composer-parts', () => ({
  CommentBodyField: 'CommentBodyField',
}));
vi.mock('@/components/pr-review/discussion/reply-input', () => ({
  ensureTermsAcceptedOutcome: gate.ensureTermsAcceptedOutcome,
}));
vi.mock('@/lib/pr-review/discussion/use-review-discussion-mutations', () => ({
  useAddPrCommentMutation: () => ({ mutateAsync: addComment.mutateAsync }),
}));
vi.mock('@/lib/pr-review/discussion/use-pr-comment-crud-mutations', () => ({
  useUpdatePrCommentMutation: () => ({ mutateAsync: updateComment.mutateAsync }),
}));
vi.mock('@/lib/hooks/use-current-user-id', () => ({
  useCurrentUserId: () => ({ userId: 'review-copy-fixture', isLoading: false }),
}));
vi.mock('@/lib/hooks/use-offline-banner-state', () => ({
  connectionRefusesWrites: () => false,
  getCommittedConnectivityStatus: () => 'online',
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

const conversationProps = {
  owner: 'sample',
  repo: 'review-copy',
  number: 1,
  eyebrow: 'sample/review-copy#1',
  onDismiss: vi.fn(),
};

const editProps = {
  owner: 'sample',
  repo: 'review-copy',
  number: 1,
  commentId: 1,
  kind: 'review' as const,
  initialBody: 'keep the helper name',
  onDismiss: vi.fn(),
};

beforeEach(() => {
  replace.mockReset();
  confirmRequests.length = 0;
  addComment.mutateAsync.mockReset();
  updateComment.mutateAsync.mockReset();
  gate.ensureTermsAcceptedOutcome.mockReset();
  gate.ensureTermsAcceptedOutcome.mockResolvedValue({ kind: 'accepted' });
  conversationProps.onDismiss = vi.fn();
  editProps.onDismiss = vi.fn();
});

afterEach(() => {
  unmountComposers();
  unmountSheets();
});

describe('PR-review screen links', () => {
  it('navigates the GitHub shape with the triple the route parses', () => {
    expect(handlePrReviewCopyFixturePath('dev/pr-review-copy-fixture/screen-merge')).toBe(true);
    expect(replace).toHaveBeenCalledWith(
      '/(auth)/pr-review-copy-fixture?surface=screen-merge&owner=sample&repo=review-copy&number=1'
    );
  });

  it('navigates the provider shape with the identity segments the route parses', () => {
    handlePrReviewCopyFixturePath('dev/pr-review-copy-fixture/screen-merge?shape=gitlab');
    expect(replace).toHaveBeenCalledWith(
      '/(auth)/pr-review-copy-fixture?surface=screen-merge&platform=gitlab&identity=acme&identity=review-copy&identity=7&shape=gitlab'
    );
  });

  it('carries the diff position the comment-composer screen requires', () => {
    handlePrReviewCopyFixturePath('dev/pr-review-copy-fixture/screen-comment-composer');
    expect(replace.mock.calls[0]?.[0]).toContain('&path=src/greeting.ts&side=RIGHT&line=2');
  });

  it('carries the edit sheet’s comment id and its long body', () => {
    handlePrReviewCopyFixturePath('dev/pr-review-copy-fixture/screen-comment-edit?state=long');
    const href = replace.mock.calls[0]?.[0] ?? '';
    expect(href).toContain('&commentId=1&kind=review&body=');
    // The body rides percent-encoded, so the sheet's `body` param keeps the
    // punctuation (an em dash here) the long copy contains.
    expect(href).toContain(encodeURIComponent('—'));
  });

  it('ignores a name that is not a fixture surface', () => {
    expect(handlePrReviewCopyFixturePath('dev/pr-review-copy-fixture/no-such-screen')).toBe(false);
    expect(replace).not.toHaveBeenCalled();
  });
});

describe('PR-review fixture writes', () => {
  it('settles the conversation composer on its retryable error with the body kept', async () => {
    addComment.mutateAsync.mockRejectedValueOnce(new Error(FIXTURE_WRITE_REFUSED));
    const renderer = await mountSheet(
      createElement(PrConversationCommentComposer, conversationProps)
    );
    typeBody(renderer, 'a body the refusal must not lose');
    await pressComment(renderer);

    expect(composerFailureCopy(renderer)).toBe(
      i18n.t('prReview.mutationError.couldNotPostComment')
    );
    // Retryable: the same control offers the retry, and nothing was dismissed.
    expect(commentDisabled(renderer)).toBe(false);
    expect(conversationProps.onDismiss).not.toHaveBeenCalled();
    expect(confirmRequests).toHaveLength(0);
  });

  it('settles the edit sheet on its retryable error with Save kept live', async () => {
    updateComment.mutateAsync.mockRejectedValueOnce(new Error(FIXTURE_WRITE_REFUSED));
    const renderer = await mountSheet(createElement(PrCommentEditSheet, editProps));
    typeBody(renderer, 'an edit the refusal must not lose');
    await pressSave(renderer);

    expect(editFailureCopy(renderer)).toBe(i18n.t('prReview.discussion.commentEditFailed'));
    expect(saveDisabled(renderer)).toBe(false);
    expect(editProps.onDismiss).not.toHaveBeenCalled();
    expect(confirmRequests).toHaveLength(0);
  });
});

function commentDisabled(renderer: ReactTestRenderer): boolean {
  return buttonByText(renderer, i18n.t('prReview.composer.comment')).props.disabled as boolean;
}

async function pressComment(renderer: ReactTestRenderer): Promise<void> {
  await act(async () => {
    (buttonByText(renderer, i18n.t('prReview.composer.comment')).props.onPress as () => void)();
    await Promise.resolve();
  });
}
