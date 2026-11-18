import { type ReactNode } from 'react';
import { Pressable, View } from 'react-native';

import { ChevronDown, ChevronUp, Trash2 } from '@/components/ui/icons';
import { cn } from '@/lib/utils';
import {
  LINE_ACTION_BOX_CLASS,
  LINE_ACTION_OVERLAY_CLASS,
} from '@/lib/a11y/tap-target';

/**
 * The box a row's control renders in: the whole touch target on its own
 * node. `hitSlop` is not part of this shape: React Native confines a touch
 * area to its parent's bounds, and the outer side of an end-of-row control
 * has no view that dispatches into the band, so slop past the box is dead
 * there (measured: a tap inside the vertical slop band reorders the row, a
 * tap past the box's outer edge does nothing). The 46 dp box fills the
 * overlay band exactly, so both axes reach past 44 dp by construction; the
 * shared base's `-my-[7px]` cancels against the band's centering, and the
 * glyph stays centred on the label's line.
 */
const ROW_CONTROL_BOX_CLASS = cn(
  LINE_ACTION_BOX_CLASS,
  'h-[46px] w-[46px] items-center justify-center active:opacity-70'
);

function LineIconButton({
  label,
  hint,
  disabled,
  onPress,
  children,
}: Readonly<{
  label: string;
  hint: string;
  disabled?: boolean;
  onPress: () => void;
  children: ReactNode;
}>) {
  // The 46 dp square box is the target itself: no hitSlop, no parent clip.
  return (
    <Pressable
      className={cn(ROW_CONTROL_BOX_CLASS, disabled && 'opacity-40')}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      onPress={onPress}
    >
      {children}
    </Pressable>
  );
}

/**
 * A setup command field's reorder and delete controls, as the card's own
 * overlay band: `ProfileCommandRowControls` mounts the absolutely positioned
 * band ({@link LINE_ACTION_OVERLAY_CLASS}) whose parent is the card, and the
 * card's sibling field block keeps its label row one text line tall. Each
 * control's 46 dp box is the whole touch target on its own node, so both
 * axes reach past 44 dp by construction: vertically the boxes reach into the
 * card's top padding, horizontally the outer edge sits on the card's content
 * edge, where a `hitSlop` past the box was dead (no view dispatches there).
 * The band's bottom edge stops above the field, whose gap from the label row
 * the card widens with COMMAND_ROW_FIELD_GAP_CLASS, so a tap aimed at the
 * field's top strip lands on the field. `box-none` keeps the band itself
 * touch-transparent: only the control boxes take taps, and the label under
 * the band's left tail stays pressable.
 *
 * They still name their own position.
 */
export function ProfileCommandRowControls({
  color,
  hint,
  upLabel,
  downLabel,
  deleteLabel,
  canMoveUp,
  canMoveDown,
  onMoveUp,
  onMoveDown,
  onDelete,
}: Readonly<{
  color: string;
  hint: string;
  upLabel: string;
  downLabel: string;
  deleteLabel: string;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDelete: () => void;
}>) {
  return (
    <View className={LINE_ACTION_OVERLAY_CLASS} pointerEvents="box-none">
      <LineIconButton label={upLabel} hint={hint} disabled={!canMoveUp} onPress={onMoveUp}>
        <ChevronUp size={20} color={color} />
      </LineIconButton>
      <LineIconButton label={downLabel} hint={hint} disabled={!canMoveDown} onPress={onMoveDown}>
        <ChevronDown size={20} color={color} />
      </LineIconButton>
      <LineIconButton label={deleteLabel} hint={hint} onPress={onDelete}>
        <Trash2 size={20} color={color} />
      </LineIconButton>
    </View>
  );
}
