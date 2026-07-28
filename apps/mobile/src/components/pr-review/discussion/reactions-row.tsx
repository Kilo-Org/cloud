// Reactions row for a single review comment.
//
// GitHub's review-comment reactions are a fixed set of 8 emoji
// (`THUMBS_UP, THUMBS_DOWN, LAUGH, HOORAY, CONFUSED, HEART,
// ROCKET, EYES`). Each one is rendered as a small pill that shows
// the current count when > 0 and a darker fill when the viewer
// has already reacted.
//
// Tapping a pill toggles: if the viewer has reacted, fire
// `removeReaction`; otherwise `addReaction`. The optimistic cache
// reducer (`applyReactionToggle`) updates the row instantly, so the
// count + fill flip in the same frame as the tap.
//
// Disabled state is exposed for callers that want to lock the row
// during the mutation's pending phase (rare — the optimistic update
// makes the row look responsive; the hook will still rollback on
// error).

import * as Haptics from 'expo-haptics';
import { Pressable, View } from 'react-native';

import { Text } from '@/components/ui/text';
import {
  REVIEW_REACTION_CONTENTS,
  type ReviewReactionContent,
} from '@/lib/pr-review/discussion/review-discussion-types';
import { cn } from '@/lib/utils';

// Map each GitHub reaction content to the emoji that GitHub itself
// renders in its UI. Kept inline (not in a shared emoji module) so
// the discussion tab stays a self-contained slice.
const REACTION_EMOJI: Record<ReviewReactionContent, string> = {
  THUMBS_UP: '👍',
  THUMBS_DOWN: '👎',
  LAUGH: '😄',
  HOORAY: '🎉',
  CONFUSED: '😕',
  HEART: '❤️',
  ROCKET: '🚀',
  EYES: '👀',
};

type ReactionsRowProps = {
  // Raw reactions from the DTO — `content` is a plain string (GitHub can
  // return content outside the 8 emoji). We index by string and only render
  // + toggle the fixed 8 known reactions.
  readonly reactions: readonly {
    readonly content: string;
    readonly count: number;
    readonly viewerHasReacted: boolean;
  }[];
  readonly onToggle: (content: ReviewReactionContent) => void;
  readonly disabled?: boolean;
};

export function ReactionsRow({ reactions, onToggle, disabled }: Readonly<ReactionsRowProps>) {
  // Index existing reactions by content for O(1) lookup. Missing
  // reactions render as an empty pill (no count) so the user can
  // discover the full set.
  const byContent = new Map<string, { count: number; viewerHasReacted: boolean }>();
  for (const r of reactions) {
    byContent.set(r.content, { count: r.count, viewerHasReacted: r.viewerHasReacted });
  }
  return (
    <View className="flex-row flex-wrap gap-1.5">
      {REVIEW_REACTION_CONTENTS.map(content => {
        const existing = byContent.get(content);
        const count = existing?.count ?? 0;
        const reacted = existing?.viewerHasReacted ?? false;
        return (
          <ReactionPill
            key={content}
            content={content}
            emoji={REACTION_EMOJI[content]}
            count={count}
            viewerHasReacted={reacted}
            disabled={Boolean(disabled)}
            onPress={() => {
              void Haptics.selectionAsync();
              onToggle(content);
            }}
          />
        );
      })}
    </View>
  );
}

type ReactionPillProps = {
  readonly content: ReviewReactionContent;
  readonly emoji: string;
  readonly count: number;
  readonly viewerHasReacted: boolean;
  readonly disabled: boolean;
  readonly onPress: () => void;
};

function ReactionPill({
  emoji,
  count,
  viewerHasReacted,
  disabled,
  onPress,
}: Readonly<ReactionPillProps>) {
  // Reacted pills get the accent-soft fill (same as the rest of the
  // product's "active toggle" surface) so they read as selected in
  // both light and dark themes. Unreacted pills use a flat border
  // so the row stays calm when the user hasn't engaged.
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${emoji} reaction, ${count} ${count === 1 ? 'reaction' : 'reactions'}`}
      onPress={onPress}
      disabled={disabled}
      className={cn(
        'flex-row items-center gap-1 rounded-full border px-2 py-1',
        viewerHasReacted ? 'border-primary bg-accent-soft' : 'border-border bg-card'
      )}
    >
      <Text className="text-base leading-none">{emoji}</Text>
      {count > 0 ? (
        <Text
          className={cn(
            'text-xs font-medium tabular-nums',
            viewerHasReacted ? 'text-accent-soft-foreground' : 'text-muted-foreground'
          )}
        >
          {count}
        </Text>
      ) : null}
    </Pressable>
  );
}
