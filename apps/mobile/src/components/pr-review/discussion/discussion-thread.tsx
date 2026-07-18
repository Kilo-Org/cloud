// Single review-thread card: anchor header + comments list + reply input.
//
//   - The thread header shows the anchor label ("src/a.ts L10 (RIGHT)"
//     or "File comment on src/a.ts" or "Outdated on ...") and the
//     "Outdated" / "Resolved" badges when applicable.
//   - Resolved threads are COLLAPSED by default (tapping the header
//     expands them). The repo's UI/UX rule for compact product rhythm
//     is to keep the noise level down on the happy path, so an
//     accepted PR's collapsed thread pile shouldn't dominate the tab.
//   - The reply input is uncontrolled (iOS ref pattern) per the
//     repo's iOS rule and per the comment-composer reference
//     implementation. Submit calls the (non-optimistic) reply
//     mutation and re-fetches the list on settle.
//   - The resolve / unresolve / reaction toggles are OPTIMISTIC;
//     the mutation hooks own the cache update + rollback, so the
//     thread just routes the events and lets the cache flow.

import * as Haptics from 'expo-haptics';
import { Check, CheckCheck, ChevronDown, ChevronUp } from 'lucide-react-native';
import { useState } from 'react';
import { Pressable, View } from 'react-native';

import { CommentRow } from '@/components/pr-review/discussion/comment-row';
import { ReplyInput } from '@/components/pr-review/discussion/reply-input';
import { Text } from '@/components/ui/text';
import {
  type ReviewComment,
  type ReviewReactionContent,
  type ReviewThread,
  selectThreadAnchorLabel,
  selectThreadBadges,
} from '@/lib/pr-review/discussion/review-discussion-types';
import {
  useAddReactionMutation,
  useRemoveReactionMutation,
  useReplyToCommentMutation,
  useResolveThreadMutation,
  useUnresolveThreadMutation,
} from '@/lib/pr-review/discussion/use-review-discussion-mutations';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn, parseTimestamp, timeAgo } from '@/lib/utils';

type DiscussionThreadProps = {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
  readonly thread: ReviewThread;
};

export function DiscussionThread({ owner, repo, number, thread }: Readonly<DiscussionThreadProps>) {
  // Resolved threads start collapsed; active threads start expanded.
  const [expanded, setExpanded] = useState(!thread.isResolved);

  const resolve = useResolveThreadMutation();
  const unresolve = useUnresolveThreadMutation();
  const addReaction = useAddReactionMutation(thread.threadId);
  const removeReaction = useRemoveReactionMutation(thread.threadId);
  const reply = useReplyToCommentMutation();

  const anchorLabel = selectThreadAnchorLabel(thread);
  const badges = selectThreadBadges(thread);
  const firstComment = thread.comments[0];
  const isResolving = resolve.isPending || unresolve.isPending;
  const isReacting = addReaction.isPending || removeReaction.isPending;

  const onToggleResolve = () => {
    void Haptics.selectionAsync();
    if (thread.isResolved) {
      unresolve.mutate({ threadId: thread.threadId });
    } else {
      resolve.mutate({ threadId: thread.threadId });
    }
  };

  const onToggleReaction = (comment: ReviewComment, content: ReviewReactionContent) => {
    // Haptic is emitted by ReactionsRow's press handler; don't double-fire here.
    const existing = comment.reactions.find(r => r.content === content);
    if (existing?.viewerHasReacted) {
      removeReaction.mutate({ commentNodeId: comment.nodeId, content });
    } else {
      addReaction.mutate({ commentNodeId: comment.nodeId, content });
    }
  };

  return (
    <View
      accessibilityLabel={`Discussion thread ${anchorLabel}`}
      className={cn(
        'gap-3 rounded-xl border border-border bg-card p-3.5',
        thread.isResolved && 'bg-secondary'
      )}
    >
      <ThreadHeader
        anchorLabel={anchorLabel}
        resolved={badges.resolved}
        outdated={badges.outdated}
        fileLevel={badges.fileLevel}
        commentCount={thread.comments.length}
        firstTimestamp={firstComment?.createdAt ?? null}
        expanded={expanded}
        onToggleExpand={() => {
          setExpanded(prev => !prev);
        }}
        onToggleResolve={onToggleResolve}
        resolveDisabled={isResolving}
      />
      {expanded ? (
        <>
          <View className="gap-4">
            {thread.comments.map((comment, index) => (
              <View key={comment.nodeId} className={cn(index > 0 && 'border-t border-border pt-4')}>
                <CommentRow
                  comment={comment}
                  reactionsDisabled={isReacting}
                  onToggleReaction={content => {
                    onToggleReaction(comment, content);
                  }}
                />
              </View>
            ))}
          </View>
          {firstComment ? (
            <ReplyInput
              owner={owner}
              repo={repo}
              number={number}
              commentId={firstComment.commentId}
              reply={reply}
            />
          ) : null}
        </>
      ) : null}
    </View>
  );
}

// ── Header ────────────────────────────────────────────────────────────

type ThreadHeaderProps = {
  readonly anchorLabel: string;
  readonly resolved: boolean;
  readonly outdated: boolean;
  readonly fileLevel: boolean;
  readonly commentCount: number;
  readonly firstTimestamp: string | null;
  readonly expanded: boolean;
  readonly onToggleExpand: () => void;
  readonly onToggleResolve: () => void;
  readonly resolveDisabled: boolean;
};

function ThreadHeader({
  anchorLabel,
  resolved,
  outdated,
  fileLevel,
  commentCount,
  firstTimestamp,
  expanded,
  onToggleExpand,
  onToggleResolve,
  resolveDisabled,
}: Readonly<ThreadHeaderProps>) {
  const colors = useThemeColors();
  const relative = firstTimestamp ? timeAgo(parseTimestamp(firstTimestamp)) : null;
  return (
    <View className="gap-2">
      <View className="flex-row items-start justify-between gap-2">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={expanded ? 'Collapse thread' : 'Expand thread'}
          onPress={onToggleExpand}
          className="flex-1 flex-row items-center gap-2"
        >
          {expanded ? (
            <ChevronUp size={16} color={colors.mutedForeground} />
          ) : (
            <ChevronDown size={16} color={colors.mutedForeground} />
          )}
          <Text className="font-mono-medium text-[12px] text-foreground" numberOfLines={1}>
            {anchorLabel}
          </Text>
        </Pressable>
        <ResolveToggle resolved={resolved} disabled={resolveDisabled} onPress={onToggleResolve} />
      </View>
      <View className="flex-row flex-wrap items-center gap-1.5">
        {resolved ? <Badge tone="good" icon={CheckCheck} label="Resolved" /> : null}
        {outdated ? <Badge tone="muted" label="Outdated" /> : null}
        {fileLevel && !resolved ? <Badge tone="muted" label="File" /> : null}
        <Text variant="muted" className="text-xs">
          {commentCount === 1 ? '1 comment' : `${commentCount} comments`}
          {relative ? ` · started ${relative}` : ''}
        </Text>
      </View>
    </View>
  );
}

type BadgeProps = {
  readonly tone: 'good' | 'muted' | 'warn' | 'destructive';
  readonly icon?: typeof Check;
  readonly label: string;
};

const BADGE_TONE_CLASS: Record<BadgeProps['tone'], string> = {
  good: 'bg-secondary text-good',
  warn: 'bg-secondary text-warn',
  destructive: 'bg-secondary text-destructive',
  muted: 'bg-secondary text-muted-foreground',
};

function Badge({ tone, icon: Icon, label }: Readonly<BadgeProps>) {
  const colors = useThemeColors();
  const toneClass = BADGE_TONE_CLASS[tone];
  // Native Lucide icons don't resolve NativeWind text classes, so set the
  // icon color explicitly per tone from the theme tokens.
  const iconColor: Record<BadgeProps['tone'], string> = {
    good: colors.good,
    warn: colors.warn,
    destructive: colors.destructive,
    muted: colors.mutedForeground,
  };
  return (
    <View className={cn('flex-row items-center gap-1 rounded-full px-2 py-0.5', toneClass)}>
      {Icon ? <Icon size={10} color={iconColor[tone]} /> : null}
      <Text className="text-[10px] font-medium uppercase tracking-wide">{label}</Text>
    </View>
  );
}

type ResolveToggleProps = {
  readonly resolved: boolean;
  readonly disabled: boolean;
  readonly onPress: () => void;
};

function ResolveToggle({ resolved, disabled, onPress }: Readonly<ResolveToggleProps>) {
  const colors = useThemeColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={resolved ? 'Unresolve thread' : 'Resolve thread'}
      onPress={onPress}
      disabled={disabled}
      hitSlop={8}
      className="flex-row items-center gap-1.5 self-start rounded-full border border-border bg-card px-2.5 py-1"
    >
      <Check size={12} color={resolved ? colors.good : colors.mutedForeground} />
      <Text
        className={cn('text-[11px] font-medium', resolved ? 'text-good' : 'text-muted-foreground')}
      >
        {resolved ? 'Resolved' : 'Resolve'}
      </Text>
    </Pressable>
  );
}
