import { type ReactNode } from 'react';
import { Pressable, View } from 'react-native';

import { ChevronDown, ChevronUp, Trash2 } from '@/components/ui/icons';
import { cn } from '@/lib/utils';
import { LINE_ACTION_BOX_CLASS, LINE_ACTION_HIT_SLOP } from '@/lib/a11y/tap-target';

/** The box a row's control floats on the field's label line, at the 36 dp width floor. */
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
  // The box floats a 28 dp high, 36 dp wide frame over the label line and
  // reaches 46 dp each way with its slop, so the row is one text line tall.
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
 * A setup command field's reorder and delete controls. They sit on the field's
 * own label line as its accessory, so the card is its label row and its input
 * and carries no separate control band under the input. They still name their
 * own position, and the row's 10.5 dp gap keeps the neighbouring 5 dp slop
 * bands apart (10 dp), so a tap beside one control never reaches the next.
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
    <View className="flex-row items-center gap-3">
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
