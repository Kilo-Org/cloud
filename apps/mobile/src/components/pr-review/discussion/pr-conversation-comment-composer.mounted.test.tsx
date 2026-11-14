// Mounted coverage for the PR conversation composer: one admitted submit, the
// empty-body validation, and the two rejection policies (a server bad-request
// stays retryable, the ledger persistence marker blocks until an edit).

import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { act, type ReactTestRenderer } from '@/test/renderer';

import { PrConversationCommentComposer } from './pr-conversation-comment-composer';
import {
  buttonByText,
  failureCopy,
  mount,
  typeBody,
  unmountAll,
} from './pr-conversation-comment-composer.test-helpers';
import { i18n } from '@/i18n';
import { PR_OPERATION_PERSISTENCE_FAILED_MESSAGE } from '@/lib/pr-review/merge/pr-operation-ledger';
import { providerPrRefKey } from '@/lib/pr-review/provider-pr-ref';
import { clearDraft, saveDraft } from '@/lib/persist/drafts';

type ConfirmRequest = {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
};

const { addComment, gate, connectivity, confirmRequests, backHandler } = vi.hoisted(() => ({
  addComment: { mutateAsync: vi.fn<(input: unknown) => Promise<unknown>>() },
  gate: { ensureTermsAcceptedOutcome: vi.fn<() => Promise<{ kind: string }>>() },
  connectivity: { value: 'online' },
  confirmRequests: [] as ConfirmRequest[],
  backHandler: { current: null as null | (() => boolean) },
}));

// The Expo modules in this graph read the build-time `__DEV__` global when they
// load, and this node project does not define it.
vi.hoisted(() => {
  Object.assign(globalThis, { __DEV__: false });
});

vi.mock('react-native', () => ({
  BackHandler: {
    addEventListener: (_event: string, handler: () => boolean) => {
      backHandler.current = handler;
      return {
        remove: () => {
          backHandler.current = null;
        },
      };
    },
  },
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
  connectionRefusesWrites: () => connectivity.value === 'offline',
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

function pressComment(renderer: ReactTestRenderer): void {
  act(() => {
    (buttonByText(renderer, i18n.t('prReview.composer.comment')).props.onPress as () => void)();
  });
}

/** Presses Comment and lets the submit promise settle before act returns. */
async function pressCommentAndSettle(renderer: ReactTestRenderer): Promise<void> {
  await act(async () => {
    pressComment(renderer);
    await Promise.resolve();
  });
}

function commentDisabled(renderer: ReactTestRenderer): boolean {
  return buttonByText(renderer, i18n.t('prReview.composer.comment')).props.disabled as boolean;
}

beforeEach(() => {
  confirmRequests.length = 0;
  backHandler.current = null;
  connectivity.value = 'online';
  addComment.mutateAsync.mockReset();
  gate.ensureTermsAcceptedOutcome.mockReset();
  gate.ensureTermsAcceptedOutcome.mockResolvedValue({ kind: 'accepted' });
  vi.mocked(clearDraft).mockReset();
  vi.mocked(saveDraft).mockReset();
  baseProps.onDismiss = vi.fn();
});

afterEach(() => {
  unmountAll();
});

describe('PrConversationCommentComposer', () => {
  it('keys the durable draft per provider ref so a same-named GitHub PR and GitLab MR never share one', async () => {
    const gitlabRef = { platform: 'gitlab' as const, projectPath: 'group/sub/repo', mrIid: 12 };
    const refKey = `pr-conversation:key@${providerPrRefKey(gitlabRef)}`;

    const renderer = await mount(
      createElement(PrConversationCommentComposer, { ...baseProps, prRef: gitlabRef })
    );
    typeBody(renderer, 'hello');
    expect(saveDraft).toHaveBeenCalledWith('u1', refKey, 'hello');

    addComment.mutateAsync.mockResolvedValue({});
    await pressCommentAndSettle(renderer);
    expect(clearDraft).toHaveBeenCalledWith('u1', refKey);
    expect(baseProps.onDismiss).toHaveBeenCalledTimes(1);
  });

  it('fails a submit while confirmed offline at once and posts when the banner clears', async () => {
    connectivity.value = 'offline';
    const renderer = await mount(createElement(PrConversationCommentComposer, baseProps));
    typeBody(renderer, 'hello');
    await pressCommentAndSettle(renderer);

    // Nothing was sent: no request, no spinner, the gate never ran, and the
    // same control offers the retry.
    expect(addComment.mutateAsync).not.toHaveBeenCalled();
    expect(gate.ensureTermsAcceptedOutcome).not.toHaveBeenCalled();
    expect(failureCopy(renderer)).toBe(i18n.t('prReview.mutationError.couldNotPostComment'));
    expect(commentDisabled(renderer)).toBe(false);
    expect(clearDraft).not.toHaveBeenCalled();
    expect(baseProps.onDismiss).not.toHaveBeenCalled();

    connectivity.value = 'online';
    addComment.mutateAsync.mockResolvedValue({});
    await pressCommentAndSettle(renderer);
    expect(addComment.mutateAsync).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['BAD_REQUEST', i18n.t('prReview.discussion.commentBadRequest'), 'bad-request'],
    ['FORBIDDEN', i18n.t('prReview.discussion.commentForbidden'), 'forbidden'],
  ])('keeps its own copy for a %s rejection', async (code, copy, kind) => {
    addComment.mutateAsync.mockRejectedValue(
      Object.assign(new Error('rejected'), { data: { code } })
    );
    const renderer = await mount(createElement(PrConversationCommentComposer, baseProps));
    typeBody(renderer, 'hello');
    await pressCommentAndSettle(renderer);

    // The conversation surface words its own rejection; `kind` decides whether
    // the CTA stays live (bad-request) or goes down (forbidden).
    expect(failureCopy(renderer)).toBe(copy);
    expect(commentDisabled(renderer)).toBe(kind === 'forbidden');
  });

  describe('dismissal gate', () => {
    function pressCancel(renderer: ReactTestRenderer): void {
      act(() => {
        (buttonByText(renderer, i18n.t('common.cancel')).props.onPress as () => void)();
      });
    }

    function pressHeaderBack(renderer: ReactTestRenderer): void {
      act(() => {
        (renderer.root.findByType('PrFormSheetHeader').props.onBack as () => void)();
      });
    }

    function pressHardwareBack(): void {
      act(() => {
        backHandler.current?.();
      });
    }

    it.each([
      ['the footer Cancel', pressCancel],
      ['the header close', pressHeaderBack],
      ['the hardware back', pressHardwareBack],
    ] as const)(
      'dismisses %s with an empty body without a discard confirm',
      async (_name, trigger) => {
        const renderer = await mount(createElement(PrConversationCommentComposer, baseProps));
        trigger(renderer);

        expect(confirmRequests).toHaveLength(0);
        expect(clearDraft).not.toHaveBeenCalled();
        expect(baseProps.onDismiss).toHaveBeenCalledTimes(1);
      }
    );

    it('writes nothing when the composer is dismissed during the Terms read', async () => {
      const roundTrip = Promise.withResolvers<{ kind: string }>();
      gate.ensureTermsAcceptedOutcome.mockReturnValueOnce(roundTrip.promise);
      addComment.mutateAsync.mockResolvedValue({});
      const renderer = await mount(createElement(PrConversationCommentComposer, baseProps));
      typeBody(renderer, 'hello');

      act(() => {
        pressComment(renderer);
      });
      act(() => {
        (buttonByText(renderer, i18n.t('common.cancel')).props.onPress as () => void)();
      });

      await act(async () => {
        roundTrip.resolve({ kind: 'accepted' });
        await Promise.resolve();
      });

      expect(addComment.mutateAsync).not.toHaveBeenCalled();
      expect(clearDraft).not.toHaveBeenCalled();
    });

    it('stays on the composer with the retryable copy when the discard clear fails', async () => {
      vi.mocked(clearDraft).mockResolvedValue(false);
      const renderer = await mount(createElement(PrConversationCommentComposer, baseProps));
      typeBody(renderer, 'hello');
      pressCancel(renderer);
      confirmRequests.at(-1)?.onConfirm();
      await act(async () => {
        await Promise.resolve();
      });

      // The stored draft could not be removed: dismissing would resurface the
      // text on the next open, so the sheet stays and this copy offers the
      // retry.
      expect(clearDraft).toHaveBeenCalledWith('u1', 'pr-conversation:key');
      expect(baseProps.onDismiss).not.toHaveBeenCalled();
      expect(failureCopy(renderer)).toBe(i18n.t('agentChat.newSession.discardFailed'));
    });
  });

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

    await pressCommentAndSettle(renderer);
    expect(addComment.mutateAsync).toHaveBeenCalledTimes(1);
  });

  it('keeps Comment live after a server bad-request so the retry needs no retyping', async () => {
    addComment.mutateAsync.mockRejectedValueOnce(
      Object.assign(new Error('stale'), { data: { code: 'BAD_REQUEST' } })
    );
    const renderer = await mount(createElement(PrConversationCommentComposer, baseProps));
    typeBody(renderer, 'hello');

    await pressCommentAndSettle(renderer);

    expect(failureCopy(renderer)).toBe(i18n.t('prReview.discussion.commentBadRequest'));
    expect(commentDisabled(renderer)).toBe(false);
  });

  it('blocks Comment on the ledger persistence marker until the next keystroke', async () => {
    addComment.mutateAsync.mockRejectedValueOnce(
      new Error(PR_OPERATION_PERSISTENCE_FAILED_MESSAGE)
    );
    const renderer = await mount(createElement(PrConversationCommentComposer, baseProps));
    typeBody(renderer, 'hello');

    await pressCommentAndSettle(renderer);

    expect(failureCopy(renderer)).toBe(i18n.t('common.actionNotRecorded'));
    expect(commentDisabled(renderer)).toBe(true);

    typeBody(renderer, 'hello again');
    expect(commentDisabled(renderer)).toBe(false);
    expect(renderer.root.findAllByType('AccessibleStatus')).toHaveLength(0);
  });
});
