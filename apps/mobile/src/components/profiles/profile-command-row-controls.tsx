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
  // The box floats a 28 dp high, 36 dp wide frame over the label line, so the
  // row is one text line tall. The 5 dp side slop reaches 45.8 dp across.
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
 * A setup command field's reorder and delete controls. Each control floats the
 * shared line action box, with a 36 dp width floor, on the field's label line,
 * so the card's header row is the one 17.5 dp text line and the card's top
 * padding equals its bottom padding. The 5 dp side slop reaches 45.8 dp
 * across. The row's 10.66 dp gap keeps the neighbouring 5 dp slop bands apart
 * with 0.66 dp clearance, so a tap beside one control never reaches the next.
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
