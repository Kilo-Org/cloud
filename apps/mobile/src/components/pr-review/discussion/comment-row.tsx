// Single review-comment row: author block + Markdown body + reactions.
//
// `useThemeColors` drives the Lucide / accent colors. Author
// rendering reuses the same "avatar + login / 'deleted user'"
// pattern as the Overview tab's `PrAuthorRow`, so a deleted
// account surfaces as a muted circle + "deleted user" label.
//
// Reactions are rendered via the `ReactionsRow` subcomponent; the
// toggle is a single callback so the comment row does not need to
// know about the mutations.
//
// The trailing overflow menu offers the moderation actions: Report
// content, Report user, Mute, and Block. Report content targets the
// comment id; the user actions target the author's GitHub login.
// User actions are hidden when the author is null (deleted account)
// and disabled when the author is the viewer (self-target).

import { useActionSheet } from '@expo/react-native-action-sheet';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { MarkdownText } from '@/components/agents/markdown-text';
import { MoreHorizontal } from '@/components/ui/icons';
import { Image } from '@/components/ui/image';
import { Text } from '@/components/ui/text';
import { ReactionsRow } from '@/components/pr-review/discussion/reactions-row';
import { announcingToast } from '@/lib/a11y/announcing-toast';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import {
  type ReviewComment,
  type ReviewReactionContent,
  selectCommentAuthorName,
} from '@/lib/pr-review/discussion/review-discussion-types';
import { useTRPC } from '@/lib/trpc';
import { parseTimestamp, timeAgo } from '@/lib/utils';
import { Alert, Pressable, View } from 'react-native';

type CommentRowProps = {
  readonly comment: ReviewComment;
  readonly onToggleReaction: (content: ReviewReactionContent) => void;
  readonly reactionsDisabled?: boolean;
  readonly readOnly?: boolean;
  /** The viewer's GitHub login, used to disable self-target moderation. */
  readonly viewerLogin?: string | null;
};

const REPORT_PLATFORM = 'mobile';

type ModerationAction = 'report-content' | 'report-user' | 'mute' | 'block';

type ModerationFailure =
  | { kind: 'terminal'; message: string }
  | { kind: 'retryable'; message: string };

const TERMINAL_MESSAGES: Record<ModerationAction, string> = {
  'report-content': "This comment can't be reported.",
  'report-user': "This user can't be reported.",
  mute: "This user can't be muted.",
  block: "This user can't be blocked.",
};

const RETRYABLE_MESSAGES: Record<ModerationAction, string> = {
  'report-content': "Couldn't report this comment. Check your connection and try again.",
  'report-user': "Couldn't report this user. Check your connection and try again.",
  mute: "Couldn't mute this user. Check your connection and try again.",
  block: "Couldn't block this user. Check your connection and try again.",
};

/** Terminal moderation failures must not be retried; everything else is retryable. */
export function moderationFailure(action: ModerationAction, error: unknown): ModerationFailure {
  const code = (error as { data?: { code?: string } } | null)?.data?.code;
  if (
    code === 'BAD_REQUEST' ||
    code === 'FORBIDDEN' ||
    code === 'UNAUTHORIZED' ||
    code === 'NOT_FOUND' ||
    code === 'UNPROCESSABLE_CONTENT'
  ) {
    return { kind: 'terminal', message: TERMINAL_MESSAGES[action] };
  }
  return { kind: 'retryable', message: RETRYABLE_MESSAGES[action] };
}

/** Terminal failures toast once; retryable failures offer a Retry CTA. */
function showModerationFailure(action: ModerationAction, error: unknown, retry: () => void): void {
  const failure = moderationFailure(action, error);
  if (failure.kind === 'terminal') {
    announcingToast.error(failure.message);
    return;
  }
  Alert.alert('Something went wrong', failure.message, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Retry', onPress: retry },
  ]);
}

export function CommentRow({
  comment,
  onToggleReaction,
  reactionsDisabled,
  readOnly,
  viewerLogin = null,
}: Readonly<CommentRowProps>) {
  const authorName = selectCommentAuthorName(comment.author);
  const timestamp = parseTimestamp(comment.createdAt);
  const relative = timeAgo(timestamp);
  const colors = useThemeColors();
  const { bottom } = useSafeAreaInsets();
  const { showActionSheetWithOptions } = useActionSheet();
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const invalidateHiddenUsers = () => {
    void queryClient.invalidateQueries({ queryKey: trpc.moderation.listHiddenUsers.queryKey() });
  };

  const reportContent = useMutation(
    trpc.moderation.reportContent.mutationOptions({
      onSuccess: result => announcingToast.success(`Report submitted. Receipt ${result.receiptId}`),
      onError: (error, variables) => {
        showModerationFailure('report-content', error, () => {
          reportContent.mutate(variables);
        });
      },
    })
  );
  const reportUser = useMutation(
    trpc.moderation.reportUser.mutationOptions({
      onSuccess: result => announcingToast.success(`Report submitted. Receipt ${result.receiptId}`),
      onError: (error, variables) => {
        showModerationFailure('report-user', error, () => {
          reportUser.mutate(variables);
        });
      },
    })
  );
  const blockUser = useMutation(
    trpc.moderation.blockUser.mutationOptions({
      onSuccess: (_result, input) => {
        invalidateHiddenUsers();
        announcingToast.success(`Blocked ${input.githubLogin}`);
      },
      onError: (error, variables) => {
        showModerationFailure('block', error, () => {
          blockUser.mutate(variables);
        });
      },
    })
  );
  const muteUser = useMutation(
    trpc.moderation.muteUser.mutationOptions({
      onSuccess: (_result, input) => {
        invalidateHiddenUsers();
        announcingToast.success(`Muted ${input.githubLogin}`);
      },
      onError: (error, variables) => {
        showModerationFailure('mute', error, () => {
          muteUser.mutate(variables);
        });
      },
    })
  );

  function openOverflow() {
    const author = comment.author;
    const isSelf = author !== null && viewerLogin !== null && author.login === viewerLogin;
    const userActions: { label: string; run: () => void }[] = [];
    if (author !== null) {
      userActions.push({
        label: 'Report user',
        run: () => {
          reportUser.mutate({ targetId: author.login, reason: 'other' });
        },
      });
      userActions.push({
        label: 'Mute',
        run: () => {
          muteUser.mutate({ githubLogin: author.login });
        },
      });
      userActions.push({
        label: 'Block',
        run: () => {
          blockUser.mutate({ githubLogin: author.login });
        },
      });
    }
    const options = ['Report content', ...userActions.map(action => action.label), 'Cancel'];
    const disabledButtonIndices = isSelf ? userActions.map((_, index) => 1 + index) : [];
    showActionSheetWithOptions(
      {
        options,
        cancelButtonIndex: options.length - 1,
        disabledButtonIndices,
        containerStyle: { paddingBottom: bottom },
      },
      index => {
        if (index === undefined) {
          return;
        }
        if (index === 0) {
          reportContent.mutate({
            surface: 'pr_discussion_content',
            targetKind: 'comment',
            targetId: String(comment.commentId),
            reason: 'other',
            context: { platform: REPORT_PLATFORM },
          });
          return;
        }
        userActions[index - 1]?.run();
      }
    );
  }

  return (
    <View className="gap-2.5">
      <View className="flex-row items-center gap-2">
        {comment.author?.avatarUrl ? (
          <Image
            source={{ uri: comment.author.avatarUrl }}
            className="size-6 rounded-full"
            transition={0}
            accessibilityIgnoresInvertColors
          />
        ) : (
          <View className="size-6 rounded-full bg-muted" />
        )}
        <Text className="text-sm font-medium text-foreground" numberOfLines={1}>
          {authorName}
        </Text>
        <Text variant="muted" className="text-xs">
          {relative}
        </Text>
        <Pressable
          onPress={openOverflow}
          accessibilityRole="button"
          accessibilityLabel="Comment actions"
          hitSlop={8}
          className="ml-auto h-7 w-7 items-center justify-center rounded-full active:bg-muted"
        >
          <MoreHorizontal size={16} color={colors.mutedForeground} />
        </Pressable>
      </View>
      <MarkdownText value={comment.bodyMarkdown} selectable={false} />
      <ReactionsRow
        reactions={comment.reactions}
        onToggle={onToggleReaction}
        disabled={reactionsDisabled}
        readOnly={readOnly}
      />
    </View>
  );
}
