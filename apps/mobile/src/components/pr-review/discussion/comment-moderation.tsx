// Shared comment-moderation actions for every mounted comment row.
//
// Each row used to mount four `useMutation` hooks (report content, report user,
// mute, block) that are only reachable from its overflow action sheet: N
// mounted rows held 4N mutation-cache listeners, all notified on every
// mutation anywhere in the app, and rebuilt four option closures per row per
// render. The Discussion tab mounts one `CommentModerationProvider` for the
// whole list and every row reads the same four mutations through
// `useCommentModerationActions`.
//
// The provider is required, not optional: there is no second path in which a
// row still owns mutations, so a row outside the provider is a bug and the
// reader throws rather than falling back to a private set of mutations.

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createContext, type ReactNode, useContext, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { i18n } from '@/i18n';
import { announcingToast } from '@/lib/a11y/announcing-toast';
import { useTRPC } from '@/lib/trpc';
import { isTerminalTrpcCode, readTrpcErrorField } from '@/lib/trpc-error';
import { Alert } from 'react-native';

const REPORT_PLATFORM = 'mobile';

type ModerationAction = 'report-content' | 'report-user' | 'mute' | 'block';

type ModerationFailure =
  | { kind: 'terminal'; message: string }
  | { kind: 'retryable'; message: string };

const TERMINAL_KEYS = {
  'report-content': 'prReview.discussion.moderation.reportContent.terminal',
  'report-user': 'prReview.discussion.moderation.reportUser.terminal',
  mute: 'prReview.discussion.moderation.mute.terminal',
  block: 'prReview.discussion.moderation.block.terminal',
} as const satisfies Record<ModerationAction, string>;

const RETRYABLE_KEYS = {
  'report-content': 'prReview.discussion.moderation.reportContent.retryable',
  'report-user': 'prReview.discussion.moderation.reportUser.retryable',
  mute: 'prReview.discussion.moderation.mute.retryable',
  block: 'prReview.discussion.moderation.block.retryable',
} as const satisfies Record<ModerationAction, string>;

/** Terminal moderation failures must not be retried; everything else is retryable. */
export function moderationFailure(action: ModerationAction, error: unknown): ModerationFailure {
  const code = readTrpcErrorField(error, 'code');
  if (isTerminalTrpcCode(code)) {
    return { kind: 'terminal', message: i18n.t(TERMINAL_KEYS[action]) };
  }
  return { kind: 'retryable', message: i18n.t(RETRYABLE_KEYS[action]) };
}

/** Terminal failures toast once; retryable failures offer a Retry CTA. */
function showModerationFailure(action: ModerationAction, error: unknown, retry: () => void): void {
  const failure = moderationFailure(action, error);
  if (failure.kind === 'terminal') {
    announcingToast.error(failure.message);
    return;
  }
  Alert.alert(i18n.t('common.somethingWentWrong'), failure.message, [
    { text: i18n.t('common.cancel'), style: 'cancel' },
    { text: i18n.t('common.retry'), onPress: retry },
  ]);
}

/**
 * One moderation request, discriminated so a row names the action and its
 * target instead of reaching for a specific mutation.
 */
type CommentModerationRequest =
  | { readonly action: 'report-content'; readonly commentId: number }
  | { readonly action: 'report-user'; readonly githubLogin: string }
  | { readonly action: 'mute'; readonly githubLogin: string }
  | { readonly action: 'block'; readonly githubLogin: string };

export type CommentModeration = {
  readonly report: (request: CommentModerationRequest) => void;
};

/**
 * Build the four moderation mutations once and hand out a single `report`
 * dispatcher. The declaration order (reportContent, reportUser, blockUser,
 * muteUser) is the order the tests index the captured mutation options in.
 */
function useCommentModeration(): CommentModeration {
  const { t } = useTranslation();
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const invalidateHiddenUsers = () => {
    void queryClient.invalidateQueries({ queryKey: trpc.moderation.listHiddenUsers.queryKey() });
  };

  const { mutate: reportContent } = useMutation(
    trpc.moderation.reportContent.mutationOptions({
      onSuccess: result =>
        announcingToast.success(
          t('common.reportSubmittedReceipt', { receiptId: result.receiptId })
        ),
      onError: (error, variables) => {
        showModerationFailure('report-content', error, () => {
          reportContent(variables);
        });
      },
    })
  );
  const { mutate: reportUser } = useMutation(
    trpc.moderation.reportUser.mutationOptions({
      onSuccess: result =>
        announcingToast.success(
          t('common.reportSubmittedReceipt', { receiptId: result.receiptId })
        ),
      onError: (error, variables) => {
        showModerationFailure('report-user', error, () => {
          reportUser(variables);
        });
      },
    })
  );
  const { mutate: blockUser } = useMutation(
    trpc.moderation.blockUser.mutationOptions({
      onSuccess: (_result, input) => {
        invalidateHiddenUsers();
        announcingToast.success(t('prReview.discussion.blockedUser', { login: input.githubLogin }));
      },
      onError: (error, variables) => {
        showModerationFailure('block', error, () => {
          blockUser(variables);
        });
      },
    })
  );
  const { mutate: muteUser } = useMutation(
    trpc.moderation.muteUser.mutationOptions({
      onSuccess: (_result, input) => {
        invalidateHiddenUsers();
        announcingToast.success(t('prReview.discussion.mutedUser', { login: input.githubLogin }));
      },
      onError: (error, variables) => {
        showModerationFailure('mute', error, () => {
          muteUser(variables);
        });
      },
    })
  );

  // Key on the four `mutate` functions: TanStack returns a fresh result object
  // per render but the `mutate` callbacks are stable, so keying on the object
  // would rebuild the value (and re-render every row holding it) every render.
  return useMemo(
    () => ({
      report: request => {
        switch (request.action) {
          case 'report-content': {
            reportContent({
              surface: 'pr_discussion_content',
              targetKind: 'comment',
              targetId: String(request.commentId),
              reason: 'other',
              context: { platform: REPORT_PLATFORM },
            });
            break;
          }
          case 'report-user': {
            reportUser({ targetId: request.githubLogin, reason: 'other' });
            break;
          }
          case 'mute': {
            muteUser({ githubLogin: request.githubLogin });
            break;
          }
          case 'block': {
            blockUser({ githubLogin: request.githubLogin });
            break;
          }
          default: {
            // Unreachable: `request.action` is the exhaustive discriminated union.
            break;
          }
        }
      },
    }),
    [blockUser, muteUser, reportContent, reportUser]
  );
}

const CommentModerationContext = createContext<CommentModeration | null>(null);

/** Provide the shared moderation actions to every comment row under it. */
export function CommentModerationProvider({ children }: { readonly children: ReactNode }) {
  const moderation = useCommentModeration();
  return (
    <CommentModerationContext.Provider value={moderation}>
      {children}
    </CommentModerationContext.Provider>
  );
}

/** Read the provider's shared moderation actions; throws without a provider. */
export function useCommentModerationActions(): CommentModeration {
  const moderation = useContext(CommentModerationContext);
  if (moderation === null) {
    throw new Error('useCommentModerationActions must be used inside a CommentModerationProvider');
  }
  return moderation;
}
