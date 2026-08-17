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
import { useRef, useState } from 'react';
import { Pressable, View } from 'react-native';

import { ReactionPickerSheet } from '@/components/pr-review/discussion/reaction-picker-sheet';
import { Text } from '@/components/ui/text';
import { moveA11yFocus } from '@/lib/a11y/announce';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { REACTION_EMOJI, selectReactionPills } from '@/lib/pr-review/discussion/reaction-pills';
import { type ReviewReactionContent } from '@/lib/pr-review/discussion/review-discussion-types';
import { cn } from '@/lib/utils';

// The pill body is ~26pt tall (16pt emoji/count line + py-1 + border). Vertical
// hitSlop lifts the effective touch target to >=44pt; horizontal slop is capped
// at 2pt per side so gap-1.5 (6pt) neighbors never overlap.
const REACTION_PILL_HIT_SLOP = { top: 10, bottom: 10, left: 2, right: 2 } as const;
// "Add reaction" is ~30pt tall (16pt icon + p-1.5 + border); vertical slop
// lifts it to >=44pt with the same horizontal cap.
const ADD_REACTION_HIT_SLOP = { top: 8, bottom: 8, left: 2, right: 2 } as const;

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
  const addReactionRef = useRef<View>(null);
  const pills = selectReactionPills(reactions);
  const isDisabled = Boolean(disabled);
  const isReadOnly = Boolean(readOnly);
  const pillDisabled = isDisabled || isReadOnly;

  // Centralized close: every picker close path (close button, backdrop,
  // Android back via `onRequestClose`, and picking a reaction) flips the
  // sheet's `visible` off. Screen-reader focus is NOT restored here: the
  // native Modal stays presented for the exit animations (~200ms), and while
  // it is up the background accessibility tree (including the "Add reaction"
  // trigger) is unreachable. The sheet fires `onDismiss` only after the
  // native Modal fully dismisses, and that handler moves focus back.
  function closePicker() {
    setPickerOpen(false);
  }

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
          ref={addReactionRef}
          accessibilityRole="button"
          accessibilityLabel="Add reaction"
          accessibilityState={{ disabled: isDisabled }}
          disabled={isDisabled}
          onPress={() => {
            void Haptics.selectionAsync();
            setPickerOpen(true);
          }}
          hitSlop={ADD_REACTION_HIT_SLOP}
          className={cn(
            'rounded-full border bg-card p-1.5 active:opacity-70',
            isDisabled ? 'border-hair-soft' : 'border-border'
          )}
        >
          <SmilePlus size={16} color={colors.mutedForeground} />
        </Pressable>
      )}
      <ReactionPickerSheet
        visible={pickerOpen}
        reactions={reactions}
        onClose={closePicker}
        onPick={content => {
          void Haptics.selectionAsync();
          onToggle(content);
          closePicker();
        }}
        onDismiss={() => {
          moveA11yFocus(addReactionRef);
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
  // so the row stays calm when the user hasn't engaged. Disabled
  // pills swap the border for hair-soft as the non-color cue while
  // keeping the selected fill and full-contrast content readable.
  let borderClass = viewerHasReacted ? 'border-primary' : 'border-border';
  if (disabled) {
    borderClass = 'border-hair-soft';
  }
  // The pill is a toggle in behavior only, so it stays a button — never a
  // checkbox or switch role. `selected` mirrors the accent-soft fill.
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${emoji} reaction, ${count} ${count === 1 ? 'reaction' : 'reactions'}`}
      accessibilityState={{ selected: viewerHasReacted, disabled }}
      onPress={onPress}
      disabled={disabled}
      hitSlop={REACTION_PILL_HIT_SLOP}
      className={cn(
        'flex-row items-center gap-1 rounded-full border px-2 py-1 active:opacity-70',
        viewerHasReacted ? 'bg-accent-soft' : 'bg-card',
        borderClass
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
