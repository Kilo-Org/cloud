// Single review-thread card: anchor header + optional quoted diff +
// comments list + reply input.
//
//   - COLLAPSED: the full card root is a pressable expand target
//     (a11y: "Discussion thread <anchor>", role button, collapsed
//     state). Tapping anywhere on the card expands the thread.
//   - EXPANDED: the root is a plain view. Only the header label row
//     is pressable (collapse). The resolve toggle is its own nested
//     pressable in both states.
//   - The thread header shows the anchor label ("src/a.ts L10 (RIGHT)"
//     or "File comment on src/a.ts" or "Outdated on ...") and the
//     "Outdated" / "Resolved" badges when applicable. The "Resolved"
//     badge is the sole Resolved text indicator; the resolve control
//     is an icon-only circular button (a11y: "Resolve thread" /
//     "Unresolve thread").
//   - Expanded LINE-anchored threads render a capped quoted diff
//     snippet (from thread.diffHunk) above the comments list. File-
//     level / empty / unparseable hunks show no snippet.
//   - Resolved threads are COLLAPSED by default (tapping the card
//     root expands them). The repo's UI/UX rule for compact product
//     rhythm is to keep the noise level down on the happy path, so an
//     accepted PR's collapsed thread pile shouldn't dominate the tab.
//   - The reply input is uncontrolled (iOS ref pattern) per the
//     repo's iOS rule and per the comment-composer reference
//     implementation. Submit calls the (non-optimistic) reply
//     mutation and re-fetches the list on settle.
//   - The resolve / unresolve / reaction toggles are OPTIMISTIC;
//     the mutation hooks own the cache update + rollback, so the
//     thread just routes the events and lets the cache flow.

import * as Haptics from 'expo-haptics';
import { Check, CheckCheck, ChevronDown, ChevronUp } from '@/components/ui/icons';
import { useMemo } from 'react';
import { Pressable, View } from 'react-native';

import { CommentRow } from '@/components/pr-review/discussion/comment-row';
import { ReplyInput } from '@/components/pr-review/discussion/reply-input';
import { ThreadDiffSnippet } from '@/components/pr-review/discussion/thread-diff-snippet';
import { Text } from '@/components/ui/text';
import {
  type ReviewComment,
  type ReviewReactionContent,
  type ReviewThread,
  selectThreadAnchorLabel,
  selectThreadBadges,
} from '@/lib/pr-review/discussion/review-discussion-types';
import { selectThreadDiffSnippet } from '@/lib/pr-review/discussion/thread-diff-snippet';
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
  /** Controlled by the Discussion tab (keyed by threadId). */
  readonly expanded: boolean;
  readonly onToggleExpand: () => void;
};

export function DiscussionThread({
  owner,
  repo,
  number,
  thread,
  expanded,
  onToggleExpand,
}: Readonly<DiscussionThreadProps>) {
  const resolve = useResolveThreadMutation();
  const unresolve = useUnresolveThreadMutation();
  const addReaction = useAddReactionMutation(thread.threadId);
  const removeReaction = useRemoveReactionMutation(thread.threadId);
  const reply = useReplyToCommentMutation();

  const anchorLabel = selectThreadAnchorLabel(thread);
  const badges = selectThreadBadges(thread);
  // Parse only when expanded; memoize so DiffLine's memo comparator sees a
  // stable `lines` identity across parent re-renders (e.g. reaction toggles).
  const { diffHunk, subjectType, path } = thread;
  const diffSnippet = useMemo(
    () => (expanded ? selectThreadDiffSnippet({ diffHunk, subjectType, path }) : null),
    [expanded, diffHunk, subjectType, path]
  );
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

  const cardClassName = cn(
    'gap-3 rounded-xl border border-border bg-card p-3.5',
    thread.isResolved && 'bg-secondary'
  );
  const headerCommonProps = {
    anchorLabel,
    resolved: badges.resolved,
    outdated: badges.outdated,
    fileLevel: badges.fileLevel,
    commentCount: thread.comments.length,
    firstTimestamp: firstComment?.createdAt ?? null,
    expanded,
    onToggleResolve,
    resolveDisabled: isResolving,
    onToggleExpand,
  } as const;

  if (expanded) {
    return (
      <View accessibilityLabel={`Discussion thread ${anchorLabel}`} className={cardClassName}>
        <ThreadHeader {...headerCommonProps} />
        {diffSnippet ? <ThreadDiffSnippet snippet={diffSnippet} /> : null}
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
      </View>
    );
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Discussion thread ${anchorLabel}`}
      accessibilityState={{ expanded: false }}
      onPress={onToggleExpand}
      className={cn(cardClassName, 'active:opacity-70')}
    >
      <ThreadHeader {...headerCommonProps} />
    </Pressable>
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
  const LabelRow = (expanded ? Pressable : View) as typeof View;
  const labelRowA11y = expanded
    ? ({
        accessibilityRole: 'button',
        accessibilityLabel: 'Collapse thread',
        onPress: onToggleExpand,
      } as const)
    : ({} as const);
  return (
    <View className="gap-2">
      <View className="flex-row items-start justify-between gap-2">
        <LabelRow
          {...labelRowA11y}
          className={cn('flex-1 flex-row items-center gap-2', expanded && 'active:opacity-70')}
        >
          {expanded ? (
            <ChevronUp size={16} color={colors.mutedForeground} />
          ) : (
            <ChevronDown size={16} color={colors.mutedForeground} />
          )}
          <Text className="flex-1 font-mono-medium text-[12px] text-foreground" numberOfLines={1}>
            {anchorLabel}
          </Text>
        </LabelRow>
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
      className="h-7 w-7 items-center justify-center rounded-full border border-border bg-card"
    >
      <Check size={14} color={resolved ? colors.good : colors.mutedForeground} />
    </Pressable>
  );
}
