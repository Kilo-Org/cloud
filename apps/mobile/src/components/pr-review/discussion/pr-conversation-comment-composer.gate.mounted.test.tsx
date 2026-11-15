// Mounted coverage for the conversation composer's dismissal gate: the three
// ways out, the discard clear, and the Terms gate hand-off to Cancel.

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
import { clearDraft } from '@/lib/persist/drafts';

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

beforeEach(() => {
  confirmRequests.length = 0;
  backHandler.current = null;
  connectivity.value = 'online';
  addComment.mutateAsync.mockReset();
  gate.ensureTermsAcceptedOutcome.mockReset();
  gate.ensureTermsAcceptedOutcome.mockResolvedValue({ kind: 'accepted' });
  vi.mocked(clearDraft).mockReset();
  baseProps.onDismiss = vi.fn();
});

afterEach(() => {
  unmountAll();
});

function pressComment(renderer: ReactTestRenderer): void {
  act(() => {
    (buttonByText(renderer, i18n.t('prReview.composer.comment')).props.onPress as () => void)();
  });
}

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

  it('writes nothing for a dismissed gate and leaves the newer attempt’s slot alone', async () => {
    const abandoned = Promise.withResolvers<{ kind: string }>();
    const newer = Promise.withResolvers<{ kind: string }>();
    gate.ensureTermsAcceptedOutcome
      .mockReturnValueOnce(abandoned.promise)
      .mockReturnValueOnce(newer.promise);
    const renderer = await mount(createElement(PrConversationCommentComposer, baseProps));
    typeBody(renderer, 'hello');

    act(() => {
      pressComment(renderer);
    });
    pressCancel(renderer);
    act(() => {
      pressComment(renderer);
    });

    // The abandoned attempt's gate resolves: it writes nothing, and the
    // successor's slot survives so Cancel still reaches the newer attempt.
    await act(async () => {
      abandoned.resolve({ kind: 'accepted' });
      await Promise.resolve();
    });
    expect(confirmRequests).toHaveLength(1);
    pressCancel(renderer);
    expect(confirmRequests).toHaveLength(2);

    await act(async () => {
      newer.resolve({ kind: 'accepted' });
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
