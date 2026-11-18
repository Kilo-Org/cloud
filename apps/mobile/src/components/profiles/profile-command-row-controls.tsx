import { type ReactNode } from 'react';
import { Pressable, View } from 'react-native';

import { ChevronDown, ChevronUp, Trash2 } from '@/components/ui/icons';
import { cn } from '@/lib/utils';
import {
  LINE_ACTION_BOX_CLASS,
  LINE_ACTION_HIT_SLOP,
  LINE_ACTION_OVERLAY_CLASS,
} from '@/lib/a11y/tap-target';

/** The box a row's control renders in, at the 36 dp width floor. */
const ROW_CONTROL_BOX_CLASS = cn(
  LINE_ACTION_BOX_CLASS,
  'min-w-[36px] items-center justify-center active:opacity-70'
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
  // The 28 dp high, 36 dp wide box keeps the glyph centred on the label's
  // line; its slop reaches past 44 dp each way inside the overlay band that
  // parents this row (see LINE_ACTION_OVERLAY_CLASS).
  return (
    <Pressable
      className={cn(ROW_CONTROL_BOX_CLASS, disabled && 'opacity-40')}
      hitSlop={LINE_ACTION_HIT_SLOP}
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
 * card's sibling field block keeps its label row one text line tall. React
 * Native confines a control's touch area to its parent's bounds, so the band
 * — 46 dp tall, padded to the slop's reach — is what lets each control reach
 * 44 dp on both axes without growing the label row: vertically the band
 * reaches into the card's top padding, horizontally the card's padding
 * contains the slop. The band's bottom edge stops above the field, whose gap
 * from the label row the card widens with COMMAND_ROW_FIELD_GAP_CLASS, so a
 * tap aimed at the field's top strip lands on the field. `box-none` keeps the
 * band itself touch-transparent: only the control boxes and their slop take
 * taps, and the label under the band's left tail stays pressable.
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
