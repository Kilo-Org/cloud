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
// The viewer's OWN comment (s4) additionally offers Edit comment and
// Delete comment, wired by the Discussion tab through the optional
// `onEditComment` / `onDeleteComment` callbacks. When those are present
// the self-target moderation trio is dropped instead of rendered
// disabled — the row can never use it on itself. A read-only provider
// row passes neither callback and keeps today's menu exactly, so no
// author/scope combination ever shows a dead affordance.
//
// The trailing group beside that menu is the "Fix with Kilo" CTA
// (`PrCommentFixWithKilo`): it opens the new-session composer prefilled
// with this comment's link, scoped to the provider surface the row is on,
// and renders nothing when the comment has no addressable URL.

import { useActionSheet } from '@expo/react-native-action-sheet';
import { useTranslation } from 'react-i18next';

import { MarkdownText } from '@/components/agents/markdown-text';
import { useCommentModerationActions } from '@/components/pr-review/discussion/comment-moderation';
import { PrCommentFixWithKilo } from '@/components/pr-review/discussion/pr-comment-fix-with-kilo';
import { ReactionsRow } from '@/components/pr-review/discussion/reactions-row';
import { MoreHorizontal } from '@/components/ui/icons';
import { Image } from '@/components/ui/image';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { useThemedActionSheetOptions } from '@/lib/hooks/use-themed-action-sheet';
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
  /**
   * Edit this comment (s4). Wired only for the viewer's own comment on the
   * GitHub write surface; absent on a read-only provider scope.
   */
  readonly onEditComment?: () => void;
  /** Delete this comment (s4). Same wiring and gating as `onEditComment`. */
  readonly onDeleteComment?: () => void;
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
  onEditComment,
  onDeleteComment,
}: Readonly<CommentRowProps>) {
  const authorName = selectCommentAuthorName(comment.author);
  const timestamp = parseTimestamp(comment.createdAt);
  const relative = timeAgo(timestamp);
  const colors = useThemeColors();
  const { t } = useTranslation();
  const themedSheet = useThemedActionSheetOptions();
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
    // The viewer's own comment: Edit / Delete lead the menu and the
    // self-target moderation trio is dropped — it can never be used on
    // yourself, so three disabled entries would be a dead affordance. Without
    // both callbacks (a read-only provider row) nothing is replaced and the
    // menu keeps today's shape, disabled trio included.
    const ownActions: { label: string; run: () => void }[] = [];
    if (isSelf && onEditComment !== undefined && onDeleteComment !== undefined) {
      ownActions.push({ label: t('prReview.composer.editTitle'), run: onEditComment });
      ownActions.push({ label: t('prReview.discussion.deleteComment'), run: onDeleteComment });
    }
    const userActions: { label: string; run: () => void }[] = [];
    if (author !== null && ownActions.length === 0) {
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
    // Explicit index arithmetic: own actions occupy [0, ownActions.length),
    // report content sits at `reportContentIndex`, the user actions follow.
    const reportContentIndex = ownActions.length;
    const options = [
      ...ownActions.map(action => action.label),
      t('prReview.discussion.reportContent'),
      ...userActions.map(action => action.label),
      t('common.cancel'),
    ];
    const disabledButtonIndices = isSelf
      ? userActions.map((_, index) => reportContentIndex + 1 + index)
      : [];
    showActionSheetWithOptions(
      {
        ...themedSheet,
        options,
        cancelButtonIndex: options.length - 1,
        disabledButtonIndices,
      },
      index => {
        if (index === undefined) {
          return;
        }
        const own = ownActions[index];
        if (own !== undefined) {
          own.run();
          return;
        }
        if (index === reportContentIndex) {
          moderation.report({ action: 'report-content', commentId: comment.commentId });
          return;
        }
        userActions[index - reportContentIndex - 1]?.run();
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
