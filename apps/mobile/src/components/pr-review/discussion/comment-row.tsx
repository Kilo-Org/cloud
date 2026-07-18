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

import { MarkdownText } from '@/components/agents/markdown-text';
import { Image } from '@/components/ui/image';
import { Text } from '@/components/ui/text';
import { ReactionsRow } from '@/components/pr-review/discussion/reactions-row';
import {
  type ReviewComment,
  type ReviewReactionContent,
  selectCommentAuthorName,
} from '@/lib/pr-review/discussion/review-discussion-types';
import { parseTimestamp, timeAgo } from '@/lib/utils';
import { View } from 'react-native';

type CommentRowProps = {
  readonly comment: ReviewComment;
  readonly onToggleReaction: (content: ReviewReactionContent) => void;
  readonly reactionsDisabled?: boolean;
};

export function CommentRow({
  comment,
  onToggleReaction,
  reactionsDisabled,
}: Readonly<CommentRowProps>) {
  const authorName = selectCommentAuthorName(comment.author);
  const timestamp = parseTimestamp(comment.createdAt);
  const relative = timeAgo(timestamp);

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
      </View>
      <MarkdownText value={comment.bodyMarkdown} selectable={false} />
      <ReactionsRow
        reactions={comment.reactions}
        onToggle={onToggleReaction}
        disabled={reactionsDisabled}
      />
    </View>
  );
}
