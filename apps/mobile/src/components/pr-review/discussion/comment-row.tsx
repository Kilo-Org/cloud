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
//
// The trailing group beside that menu is the "Fix with Kilo" CTA
// (`PrCommentFixWithKilo`): it opens the new-session composer prefilled
// with this comment's link, scoped to the provider surface the row is on,
// and renders nothing when the comment has no addressable URL.

import { useActionSheet } from '@expo/react-native-action-sheet';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { MarkdownText } from '@/components/agents/markdown-text';
import { useCommentModerationActions } from '@/components/pr-review/discussion/comment-moderation';
import { PrCommentFixWithKilo } from '@/components/pr-review/discussion/pr-comment-fix-with-kilo';
import { ReactionsRow } from '@/components/pr-review/discussion/reactions-row';
import { MoreHorizontal } from '@/components/ui/icons';
import { Image } from '@/components/ui/image';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { COMMENT_ACTIONS_HIT_SLOP } from '@/lib/pr-review/comment-trailing-controls';
import { type PrCommentKind } from '@/lib/pr-review/fix-with-kilo';
import {
  type ReviewComment,
  type ReviewReactionContent,
  selectCommentAuthorName,
} from '@/lib/pr-review/discussion/review-discussion-types';
import { parseTimestamp, timeAgo } from '@/lib/utils';
import { Pressable, View } from 'react-native';

type CommentRowProps = {
  readonly comment: ReviewComment;
  readonly onToggleReaction: (content: ReviewReactionContent) => void;
  /** The provider surface the row is on, for the Fix with Kilo CTA's link. */
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
  /** Where this row's comment lives on the provider's page (s1 anchor). */
  readonly commentKind: PrCommentKind;
  readonly reactionsDisabled?: boolean;
  readonly readOnly?: boolean;
  /**
   * The `capabilities.reactions.supported` flag (s6). False renders NO
   * reactions row at all — the provider has no reaction affordance to
   * offer, so the row shows nothing instead of an empty or failing one.
   * Defaults to true, so the GitHub call sites are unchanged.
   */
  readonly reactionsSupported?: boolean;
  /** The viewer's GitHub login, used to disable self-target moderation. */
  readonly viewerLogin?: string | null;
};

export function CommentRow({
  comment,
  onToggleReaction,
  owner,
  repo,
  number,
  commentKind,
  reactionsDisabled,
  readOnly,
  reactionsSupported = true,
  viewerLogin = null,
}: Readonly<CommentRowProps>) {
  const authorName = selectCommentAuthorName(comment.author);
  const timestamp = parseTimestamp(comment.createdAt);
  const relative = timeAgo(timestamp);
  const colors = useThemeColors();
  const { t } = useTranslation();
  const { bottom } = useSafeAreaInsets();
  const { showActionSheetWithOptions } = useActionSheet();
  const moderation = useCommentModerationActions();

  function openOverflow() {
    const author = comment.author;
    // oxlint-disable typescript-eslint/prefer-optional-chain -- the null checks guard the `.toLowerCase()` calls; `author?.login.toLowerCase()` would short-circuit to `undefined === undefined` when both are null
    const isSelf =
      author !== null &&
      viewerLogin !== null &&
      author.login.toLowerCase() === viewerLogin.toLowerCase();
    // oxlint-enable typescript-eslint/prefer-optional-chain
    const userActions: { label: string; run: () => void }[] = [];
    if (author !== null) {
      userActions.push({
        label: t('prReview.discussion.reportUser'),
        run: () => {
          moderation.report({ action: 'report-user', githubLogin: author.login });
        },
      });
      userActions.push({
        label: t('prReview.discussion.mute'),
        run: () => {
          moderation.report({ action: 'mute', githubLogin: author.login });
        },
      });
      userActions.push({
        label: t('prReview.discussion.block'),
        run: () => {
          moderation.report({ action: 'block', githubLogin: author.login });
        },
      });
    }
    const options = [
      t('prReview.discussion.reportContent'),
      ...userActions.map(action => action.label),
      t('common.cancel'),
    ];
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
          moderation.report({ action: 'report-content', commentId: comment.commentId });
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
            cachePolicy="memory"
            recyclingKey={comment.author.avatarUrl}
            accessibilityIgnoresInvertColors
          />
        ) : (
          <View className="size-6 rounded-full bg-muted" />
        )}
        <Text className="flex-1 text-sm font-medium text-foreground" numberOfLines={1}>
          {authorName}
        </Text>
        <Text variant="muted" className="text-xs">
          {relative}
        </Text>
        {/* `gap-3` (10.5pt at NativeWind's 14pt rem) exceeds the pill's 2pt
            right hitSlop plus the overflow's 3pt left slop, leaving
            commentTrailingControlsClearanceDp() dp between the two tap areas,
            so a tap anywhere on the pill — including its right edge — opens the
            session and never the moderation sheet (vr1). See
            comment-trailing-controls.ts. */}
        <View className="ml-auto flex-row items-center gap-3">
          <PrCommentFixWithKilo
            owner={owner}
            repo={repo}
            number={number}
            commentId={comment.commentId}
            kind={commentKind}
          />
          <Pressable
            onPress={openOverflow}
            accessibilityRole="button"
            accessibilityLabel={t('prReview.discussion.commentActions')}
            hitSlop={COMMENT_ACTIONS_HIT_SLOP}
            // The frame, not the 16pt glyph, is what the size audit measures.
            // The author row holds the whole frame (no negative margin: RN
            // stops delivering touches outside the parent, so a shrunk layout
            // box would leave part of the target dead). The visible circle
            // stays compact at 28pt.
            className="h-11 w-11 items-center justify-center rounded-full active:bg-muted"
          >
            <View className="h-[28px] w-[28px] items-center justify-center">
              <MoreHorizontal size={16} color={colors.mutedForeground} />
            </View>
          </Pressable>
        </View>
      </View>
      <MarkdownText value={comment.bodyMarkdown} selectable={false} />
      {reactionsSupported ? (
        <ReactionsRow
          reactions={comment.reactions}
          onToggle={onToggleReaction}
          disabled={reactionsDisabled}
          readOnly={readOnly}
        />
      ) : null}
    </View>
  );
}
