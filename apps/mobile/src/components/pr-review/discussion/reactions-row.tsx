// Reactions row for a single review comment.
//
// Renders non-zero known reaction buckets as pills, plus one
// smiley-plus "Add reaction" control that opens a picker sheet of
// all 8 GitHub review reactions. Tapping a pill or picking from the
// sheet toggles via `onToggle`; the optimistic cache reducer flips
// count + fill in the same frame.
//
// `disabled` locks presses during a pending mutation but keeps the
// add icon mounted (no flicker). `readOnly` (conversation comments)
// makes pills non-pressable and hides the add icon entirely; a
// zero-pill read-only row renders null.

import * as Haptics from 'expo-haptics';
import { SmilePlus } from '@/components/ui/icons';
import { useState } from 'react';
import { Pressable, View } from 'react-native';

import { ReactionPickerSheet } from '@/components/pr-review/discussion/reaction-picker-sheet';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { REACTION_EMOJI, selectReactionPills } from '@/lib/pr-review/discussion/reaction-pills';
import { type ReviewReactionContent } from '@/lib/pr-review/discussion/review-discussion-types';
import { cn } from '@/lib/utils';

type ReactionsRowProps = {
  // Raw reactions from the DTO — `content` is a plain string (GitHub can
  // return content outside the 8 emoji). We only render known contents
  // with count > 0.
  readonly reactions: readonly {
    readonly content: string;
    readonly count: number;
    readonly viewerHasReacted: boolean;
  }[];
  readonly onToggle: (content: ReviewReactionContent) => void;
  readonly disabled?: boolean;
  readonly readOnly?: boolean;
};

export function ReactionsRow({
  reactions,
  onToggle,
  disabled,
  readOnly,
}: Readonly<ReactionsRowProps>) {
  const colors = useThemeColors();
  const [pickerOpen, setPickerOpen] = useState(false);
  const pills = selectReactionPills(reactions);
  const isDisabled = Boolean(disabled);
  const isReadOnly = Boolean(readOnly);
  const pillDisabled = isDisabled || isReadOnly;

  if (pills.length === 0 && isReadOnly) {
    return null;
  }

  return (
    <View className="flex-row flex-wrap items-center gap-1.5">
      {pills.map(pill => (
        <ReactionPill
          key={pill.content}
          emoji={REACTION_EMOJI[pill.content]}
          count={pill.count}
          viewerHasReacted={pill.viewerHasReacted}
          disabled={pillDisabled}
          onPress={() => {
            void Haptics.selectionAsync();
            onToggle(pill.content);
          }}
        />
      ))}
      {isReadOnly ? null : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Add reaction"
          disabled={isDisabled}
          onPress={() => {
            void Haptics.selectionAsync();
            setPickerOpen(true);
          }}
          className={cn(
            'rounded-full border border-border bg-card p-1.5',
            isDisabled && 'opacity-50'
          )}
        >
          <SmilePlus size={16} color={colors.mutedForeground} />
        </Pressable>
      )}
      <ReactionPickerSheet
        visible={pickerOpen}
        reactions={reactions}
        onClose={() => {
          setPickerOpen(false);
        }}
        onPick={content => {
          void Haptics.selectionAsync();
          onToggle(content);
          setPickerOpen(false);
        }}
      />
    </View>
  );
}

type ReactionPillProps = {
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
      <Text
        className={cn(
          'text-xs font-medium tabular-nums',
          viewerHasReacted ? 'text-accent-soft-foreground' : 'text-muted-foreground'
        )}
      >
        {count}
      </Text>
    </Pressable>
  );
}
